/**
 * list_feeds and search_feeds (spec §6).
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Context } from "../context.js";
import { isVisible, resolveFolder } from "../folders.js";
import { buildMeta, toolResult } from "../server.js";

export function registerListFeeds(server: McpServer, ctx: Context): void {
  server.registerTool(
    "list_feeds",
    {
      title: "List subscribed feeds",
      description:
        "The individual sources the user subscribes to. `folders` lists every " +
        "folder a feed belongs to, not just the one asked about — a feed commonly " +
        "sits in several.",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe("Folder name or ID. Omit for every feed in scope."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      toolResult(async () => {
        const [index, subscriptions, counts] = await Promise.all([
          ctx.folders(),
          ctx.client.subscriptions(ctx.config.cache.metadataTtlMs.value),
          ctx.client.unreadCounts(ctx.config.cache.articlesTtlMs.value).catch(() => undefined),
        ]);

        const unreadById = new Map<string, number>();
        for (const row of counts?.value.unreadcounts ?? []) unreadById.set(row.id, row.count);

        const wanted = args.folder ? resolveFolder(args.folder, index, ctx.scope) : undefined;
        const visibleLabels = new Set(index.visible.map((f) => f.label));

        const feeds = subscriptions.value
          .filter((sub) => {
            const cats = sub.categories ?? [];
            if (wanted) return cats.some((c) => c.id === wanted.id);
            // No folder asked for: include anything with at least one visible
            // folder, plus uncategorised feeds when scope is unrestricted.
            if (cats.length === 0) return ctx.scope.includeFolders.length === 0;
            return cats.some((c) =>
              isVisible(
                { id: c.id, label: c.label, feedCount: 0, unread: 0 },
                ctx.scope,
              ),
            );
          })
          .map((sub) => ({
            id: sub.id,
            title: sub.title ?? sub.website ?? sub.id,
            folders: (sub.categories ?? [])
              .map((c) => c.label)
              .filter((label) => visibleLabels.has(label)),
            unread: unreadById.get(sub.id) ?? 0,
          }))
          .sort((a, b) => b.unread - a.unread);

        return {
          feeds,
          count: feeds.length,
          ...(wanted && { folder: wanted.label }),
          meta: buildMeta(ctx, {
            fetchedAt: subscriptions.fetchedAt,
            fromCache: subscriptions.fromCache,
          }),
        };
      }),
  );
}

export function registerSearchFeeds(server: McpServer, ctx: Context): void {
  server.registerTool(
    "search_feeds",
    {
      title: "Search for new feeds",
      description:
        "Search Feedly's catalogue for sources to subscribe to. This searches the " +
        "catalogue of publications, not the user's own subscriptions and not " +
        "article text. Query with a topic or publication name — \"machine learning\", " +
        "\"MIT Technology Review\" — rather than a phrase describing article content, " +
        "which returns nothing. Subscribing is not implemented: hand back the " +
        "feedId or website URL and let the user add it in Feedly.",
      inputSchema: {
        query: z.string().min(1).describe("What to search for."),
        limit: z.number().int().positive().max(50).optional().describe("Max results, default 10."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      toolResult(async () => {
        const limit = args.limit ?? 10;
        const [subscriptions, found] = await Promise.all([
          ctx.client.subscriptions(ctx.config.cache.metadataTtlMs.value),
          ctx.client.searchFeeds(args.query, limit),
        ]);

        const subscribed = new Set(subscriptions.value.map((s) => s.id));
        const results = found.value.results ?? [];

        return {
          count: results.length,
          ...(results.length === 0 && {
            hint:
              "No sources matched. Feedly searches publication names and topics, not " +
              "article text — try a broader topic or a known publication name.",
          }),
          results: results.map((r) => ({
            feedId: r.feedId,
            title: r.title ?? "(untitled)",
            website: r.website ?? null,
            subscribers: r.subscribers ?? 0,
            description: r.description ?? "",
            // Resolved from the cached subscription list, so this costs nothing.
            already_subscribed: subscribed.has(r.feedId),
          })),
          meta: buildMeta(ctx, { fetchedAt: found.fetchedAt, fromCache: found.fromCache }),
        };
      }),
  );
}
