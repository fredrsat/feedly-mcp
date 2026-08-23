/**
 * Tool registrations (spec §6).
 *
 * Six tools, no more. Each one returns the shape documented in docs/tools.md —
 * that document is the contract, so change both together or neither.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Context } from "../context.js";
import { buildMeta, toolResult } from "../server.js";
import { isVisible } from "../folders.js";
import { registerGetArticles } from "./articles.js";
import { registerListFeeds, registerSearchFeeds } from "./feeds.js";
import { registerMarkRead } from "./writes.js";

export function registerTools(server: McpServer, ctx: Context): void {
  registerListFolders(server, ctx);
  registerListFeeds(server, ctx);
  registerGetArticles(server, ctx);
  registerUnreadCounts(server, ctx);
  registerSearchFeeds(server, ctx);
  registerMarkRead(server, ctx);
}

function registerListFolders(server: McpServer, ctx: Context): void {
  server.registerTool(
    "list_folders",
    {
      title: "List Feedly folders",
      description:
        "List the user's Feedly folders with unread counts. Folder names from here " +
        "can be passed as the `folder` argument to other tools — the agent never " +
        "needs to handle raw folder IDs. Do not add the unread numbers together: a " +
        "feed can belong to several folders, so the sum double-counts. Use " +
        "unread_counts for a real total.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      toolResult(async () => {
        const { index, fetchedAt, fromCache } = await ctx.folders();
        return {
          folders: index.visible.map((f) => ({
            id: f.id,
            label: f.label,
            unread: f.unread,
          })),
          meta: buildMeta(ctx, { fetchedAt, fromCache }),
        };
      }),
  );
}

function registerUnreadCounts(server: McpServer, ctx: Context): void {
  server.registerTool(
    "unread_counts",
    {
      title: "Unread article counts",
      description:
        "How many unread articles are waiting, in total and per folder. The total " +
        "is deduplicated and is the number to trust; the per-folder figures will " +
        "not sum to it. This is the cheapest useful call — one request covers the " +
        "whole account.",
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      toolResult(async () => {
        const [{ index }, counts] = await Promise.all([
          ctx.folders(),
          ctx.client.unreadCounts(ctx.config.cache.articlesTtlMs.value),
        ]);

        const rows = counts.value.unreadcounts ?? [];

        // Feedly's own global.all row is already deduplicated across folders.
        const global = rows.find((r) => r.id.endsWith("/category/global.all"));
        const byFolder = index.visible.map((f) => ({
          label: f.label,
          unread: rows.find((r) => r.id === f.id)?.count ?? f.unread,
        }));

        const scoped =
          ctx.scope.includeFolders.length > 0 || ctx.scope.excludeFolders.length > 0;

        const notes: string[] = [];
        if (global === undefined) {
          // Summing folders would double-count every feed that sits in more than
          // one, and the largest folder is not a total either. Say so instead of
          // returning a plausible-looking wrong number.
          notes.push(
            "Feedly did not return its account-wide row, so there is no trustworthy " +
              "total. The per-folder figures cannot be added up — a feed in several " +
              "folders is counted in each.",
          );
        }
        if (scoped) {
          notes.push(
            "The total covers the whole account. Per-folder figures are limited to " +
              "folders inside the configured scope.",
          );
        }

        return {
          total: global?.count ?? null,
          total_is_account_wide: global !== undefined,
          ...(notes.length > 0 && { note: notes.join(" ") }),
          by_folder: byFolder,
          meta: buildMeta(ctx, {
            fetchedAt: counts.fetchedAt,
            fromCache: counts.fromCache,
          }),
        };
      }),
  );
}

export { isVisible };
