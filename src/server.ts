/**
 * MCP stdio server (spec §2.1, §9).
 *
 * Nothing may be written to stdout except protocol frames — diagnostics go to
 * stderr. Every tool result carries the `meta` block from spec §6 so the agent
 * can see how much of the user's quota is left and how fresh the data is.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createContext, type Context } from "./context.js";
import { SEARCH_CACHE_TTL_MS } from "./feedly.js";
import { FeedlyMcpError } from "./errors.js";
import { registerTools } from "./tools/index.js";

export const SERVER_NAME = "feedly-mcp";
export const SERVER_VERSION = "0.1.0";

export interface Meta {
  calls_used: number;
  calls_left_today?: number;
  calls_left_session: number;
  fetched_at: number;
  from_cache: boolean;
  warning?: string;
}

export function buildMeta(
  ctx: Context,
  info: { fetchedAt: number; fromCache: boolean },
): Meta {
  const snap = ctx.budget.snapshot();
  const meta: Meta = {
    calls_used: snap.used,
    calls_left_session: ctx.budget.sessionRemaining,
    fetched_at: info.fetchedAt,
    from_cache: info.fromCache,
  };
  if (snap.remaining !== undefined) meta.calls_left_today = snap.remaining;
  const warning = ctx.budget.warning();
  if (warning) meta.warning = warning;
  return meta;
}

/** Structured JSON out, named errors instead of stack traces (spec §6). */
export async function toolResult(
  ctx: Context,
  produce: () => Promise<unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const value = await produce();
    return {
      content: [{ type: "text", text: ctx.redactText(JSON.stringify(value, null, 2)) }],
    };
  } catch (err) {
    const payload =
      err instanceof FeedlyMcpError
        ? err.toToolResult()
        : {
            error: "feedly_error",
            message: err instanceof Error ? err.message : String(err),
          };
    return {
      // The client and error constructors scrub the token already. This is the
      // backstop for a throw from somewhere that does not know about it —
      // "almost never" is not what spec §3 asks for.
      content: [{ type: "text", text: ctx.redactText(JSON.stringify(payload, null, 2)) }],
      isError: true,
    };
  }
}

/**
 * Tool names, registered even when startup failed so the failure is visible.
 *
 * A server that exits on a bad config looks to the client like a connector that
 * does not exist: it reports only "Connection closed", and the actual reason —
 * a missing pair of quotes in a TOML file — goes to stderr, where nobody looks.
 * An agent then concludes the connector was never installed. Staying up and
 * answering every call with the real error turns a vanished tool into a
 * readable one.
 */
const TOOL_NAMES = [
  "list_folders",
  "list_feeds",
  "get_articles",
  "unread_counts",
  "search_feeds",
  "mark_read",
] as const;

function registerStartupFailure(server: McpServer, reason: string): void {
  const message =
    `feedly-mcp could not start: ${reason}\n\n` +
    `Nothing can be read from Feedly until this is fixed. Run "feedly-mcp doctor" ` +
    `for the full check. This is a local configuration problem — do not work ` +
    `around it by fetching the news another way.`;

  for (const name of TOOL_NAMES) {
    server.registerTool(
      name,
      {
        title: `${name} (unavailable — configuration error)`,
        description: message,
        annotations: { readOnlyHint: true },
      },
      async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: "config_invalid", message }, null, 2),
          },
        ],
        isError: true,
      }),
    );
  }
}

export async function startServer(opts: { configPath?: string } = {}): Promise<void> {
  let ctx: Context;
  try {
    ctx = createContext(opts.configPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${reason}\n\nRun "feedly-mcp doctor" for a full check.\n`);

    const broken = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    registerStartupFailure(broken, reason);
    await broken.connect(new StdioServerTransport());
    return;
  }

  // Every distinct query writes a cache file and nothing else removes them, so
  // the directory would grow for as long as the tool is installed. Once at
  // startup is enough: entries past the longest TTL can never be served anyway.
  const longestTtl = Math.max(
    ctx.config.cache.metadataTtlMs.value,
    ctx.config.cache.articlesTtlMs.value,
    SEARCH_CACHE_TTL_MS,
  );
  const pruned = ctx.client.pruneCache(longestTtl * 2);

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `${SERVER_NAME} ${SERVER_VERSION} ready` +
      `${ctx.config.writes.enabled.value ? " (writes enabled)" : ""}` +
      `${pruned > 0 ? ` — pruned ${pruned} stale cache entries` : ""}\n`,
  );
}
