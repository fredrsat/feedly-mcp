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

export function registerTools(server: McpServer, ctx: Context): void {
  registerListFolders(server, ctx);
  registerUnreadCounts(server, ctx);
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
        const index = await ctx.folders();
        return {
          folders: index.visible.map((f) => ({
            id: f.id,
            label: f.label,
            unread: f.unread,
          })),
          meta: buildMeta(ctx, { fetchedAt: Date.now(), fromCache: false }),
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
        const [index, counts] = await Promise.all([
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

        return {
          total: global?.count ?? Math.max(0, ...byFolder.map((f) => f.unread)),
          total_is_account_wide: global !== undefined,
          ...(scoped && {
            note:
              "The total covers the whole account. Per-folder figures are limited to " +
              "folders inside the configured scope.",
          }),
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
