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
  produce: () => Promise<unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const value = await produce();
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (err) {
    const payload =
      err instanceof FeedlyMcpError
        ? err.toToolResult()
        : {
            error: "feedly_error",
            message: err instanceof Error ? err.message : String(err),
          };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      isError: true,
    };
  }
}

export async function startServer(opts: { configPath?: string } = {}): Promise<void> {
  let ctx: Context;
  try {
    ctx = createContext(opts.configPath);
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n\n` +
        `Run "feedly-mcp doctor" for a full check.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `${SERVER_NAME} ${SERVER_VERSION} ready` +
      `${ctx.config.writes.enabled.value ? " (writes enabled)" : ""}\n`,
  );
}
