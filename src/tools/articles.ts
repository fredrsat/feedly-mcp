/**
 * get_articles (spec §6, §7).
 *
 * The expensive tool, so it is the one that has to be careful: one call per
 * folder rather than per feed, pagination stopped by the budget rather than by
 * optimism, and normalisation before anything is returned.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { clampHours, MAX_HOURS } from "../config.js";
import type { Context } from "../context.js";
import { FeedlyMcpError } from "../errors.js";
import type { Entry } from "../feedly.js";
import { resolveFolder, type FolderIndex } from "../folders.js";
import { dedupe, normalizeArticle, type NormalizedArticle } from "../normalize.js";
import { buildMeta, toolResult } from "../server.js";

/** Feedly's own per-request ceiling. */
const PAGE_SIZE = 100;
/** Stop runaway pagination even when the budget would allow more. */
const MAX_PAGES = 5;

/**
 * How far back the returned articles actually reach.
 *
 * `limit` bites before `hours` does on a busy folder — asking for 24 hours and
 * getting 320 articles can silently cover eight. Measured on one account: an
 * umbrella folder produced ~42 articles/hour, so any generous limit is spent
 * long before the requested window is. Without this the caller has no way to
 * tell, because `window_hours` reports what was asked for, not what arrived.
 */
export function coverageHours(
  requestedHours: number,
  truncated: boolean,
  oldestPublished: number | undefined,
  now: number = Date.now(),
): number {
  if (!truncated || !oldestPublished) return requestedHours;
  const hours = (now - oldestPublished) / 3_600_000;
  // A future or garbage timestamp must not report negative coverage.
  if (!Number.isFinite(hours) || hours <= 0) return requestedHours;
  return Math.min(requestedHours, Math.round(hours * 10) / 10);
}

interface StreamChoice {
  streamId: string;
  label: string;
  /** True when we are reading everything and must filter locally. */
  wholeAccount: boolean;
}

async function chooseStream(
  ctx: Context,
  index: FolderIndex,
  requested: string | undefined,
): Promise<StreamChoice> {
  if (requested) {
    const folder = resolveFolder(requested, index, ctx.scope);
    return { streamId: folder.id, label: folder.label, wholeAccount: false };
  }

  const fallback = ctx.config.scope.defaultFolder.value;
  if (fallback) {
    const folder = resolveFolder(fallback, index, ctx.scope);
    return { streamId: folder.id, label: folder.label, wholeAccount: false };
  }

  // Exactly one folder in scope: read it directly rather than the whole account.
  if (index.visible.length === 1) {
    const only = index.visible[0]!;
    return { streamId: only.id, label: only.label, wholeAccount: false };
  }

  // Nothing specified and no single obvious folder — one call covering
  // everything beats one call per folder (spec §7).
  const accountId = await ctx.accountId();
  return {
    streamId: `${accountId}/category/global.all`,
    label: "everything in scope",
    wholeAccount: true,
  };
}

export function registerGetArticles(server: McpServer, ctx: Context): void {
  server.registerTool(
    "get_articles",
    {
      title: "Get recent articles",
      description:
        "Recent articles from a Feedly folder, cleaned up and trimmed. Prefer a " +
        "narrower `hours` window over a larger `limit` — it costs less quota and " +
        "reads better. Articles appearing in several folders are returned once, " +
        "with every folder they belong to listed. `engagement` is Feedly's " +
        "popularity score: useful for ranking, but it is missing or zero on fresh " +
        "items, so do not sort on it alone.",
      inputSchema: {
        folder: z
          .string()
          .optional()
          .describe(
            "Folder name or ID from list_folders. Omit to use the configured " +
              "default folder, or everything in scope if none is set.",
          ),
        hours: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `How far back to look. Capped at ${MAX_HOURS} (31 days) — Feedly returns ` +
              "nothing beyond that.",
          ),
        unread_only: z.boolean().optional().describe("Skip already-read articles."),
        limit: z.number().int().positive().optional().describe("Maximum articles to return."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      toolResult(async () => {
        const defaults = ctx.config.defaults;
        const limit = args.limit ?? defaults.limit.value;
        const unreadOnly = args.unread_only ?? defaults.unreadOnly.value;
        const requestedHours = args.hours ?? defaults.hours.value;
        const { hours, clamped } = clampHours(requestedHours);

        const { index } = await ctx.folders();
        const choice = await chooseStream(ctx, index, args.folder);

        const newerThan = Date.now() - hours * 3_600_000;
        const visibleLabels = new Set(index.visible.map((f) => f.label));
        const scopeRestricted =
          ctx.scope.includeFolders.length > 0 || ctx.scope.excludeFolders.length > 0;

        const collected: Entry[] = [];
        let continuation: string | undefined;
        let pages = 0;
        let stoppedEarly: string | undefined;
        let fetchedAt = Date.now();
        let fromCache = true;

        while (collected.length < limit && pages < MAX_PAGES) {
          let page;
          try {
            page = await ctx.client.streamContents(
              {
                streamId: choice.streamId,
                count: Math.min(PAGE_SIZE, limit - collected.length),
                newerThan,
                unreadOnly,
                ranked: "newest",
                continuation,
              },
              ctx.config.cache.articlesTtlMs.value,
            );
          } catch (err) {
            // Running out of budget mid-pagination is not a failure — return
            // what we have and say why it is short.
            if (err instanceof FeedlyMcpError && err.code === "budget_exhausted" && pages > 0) {
              stoppedEarly = err.message;
              break;
            }
            throw err;
          }

          pages += 1;
          fetchedAt = page.fetchedAt;
          fromCache &&= page.fromCache;
          collected.push(...(page.value.items ?? []));

          // A missing continuation means the end of the stream, not an error.
          continuation = page.value.continuation;
          if (!continuation) break;
        }

        let articles: NormalizedArticle[] = dedupe(
          collected.map((entry) =>
            normalizeArticle(entry, {
              summaryChars: defaults.summaryChars.value,
              fullText: defaults.fullText.value,
              feedFolders: index.feedFolders,
              visibleLabels,
            }),
          ),
        );

        // Reading the whole account can surface folders the user excluded.
        if (choice.wholeAccount && scopeRestricted) {
          articles = articles.filter((a) => a.folders.length > 0);
        }

        articles.sort((a, b) => b.published - a.published);
        const truncated = articles.length > limit || Boolean(continuation) || Boolean(stoppedEarly);
        if (articles.length > limit) articles = articles.slice(0, limit);

        const oldest = articles.at(-1)?.published;
        const coveredHours = coverageHours(hours, truncated, oldest);

        return {
          articles,
          count: articles.length,
          truncated,
          folder: choice.label,
          window_hours: hours,
          covered_hours: coveredHours,
          ...(truncated &&
            oldest && {
              covered_since: oldest,
              coverage_note:
                `Asked for ${hours}h but hit the limit of ${limit} first, so this ` +
                `covers roughly the last ${coveredHours}h. To reach further back, ` +
                `narrow the folder rather than raising the limit — a bigger response ` +
                `costs more quota and more context for the same blind spot.`,
            }),
          ...(clamped && {
            note:
              `Requested ${requestedHours} hours, clamped to ${hours}. Feedly returns ` +
              "nothing past 31 days, so a larger window would have looked like an " +
              "empty result rather than an error.",
          }),
          ...(stoppedEarly && { stopped_early: stoppedEarly }),
          meta: buildMeta(ctx, { fetchedAt, fromCache: fromCache && pages > 0 }),
        };
      }),
  );
}
