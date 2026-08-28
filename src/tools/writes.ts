/**
 * mark_read (spec §8).
 *
 * The only tool that changes anything, and it is irreversible: Feedly has no
 * undo, and recovery means emailing their support. Hence two separate switches
 * — marking named articles and emptying a whole folder differ enormously in
 * what they cost if the agent has misunderstood.
 *
 * Note: unsubscribe is deliberately absent, at every configuration level.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Context } from "../context.js";
import { errors } from "../errors.js";
import { parseDuration } from "../config.js";
import { resolveFolder } from "../folders.js";
import { buildMeta, toolResult } from "../server.js";

/**
 * Entry IDs per request. Feedly documents no ceiling; this keeps requests to a
 * size that is certainly accepted, at the cost of one call per batch.
 */
const ENTRY_BATCH_SIZE = 500;

/** Accepts "7d" / "24h" or a unix-ms timestamp. */
function resolveOlderThan(input: string | number | undefined): number {
  if (input === undefined) return Date.now();
  if (typeof input === "number") return input;
  const asNumber = Number(input);
  if (Number.isFinite(asNumber) && asNumber > 1_000_000_000_000) return asNumber;
  return Date.now() - parseDuration(input, "older_than");
}

export function registerMarkRead(server: McpServer, ctx: Context): void {
  const writes = ctx.config.writes;

  server.registerTool(
    "mark_read",
    {
      title: "Mark articles as read",
      description:
        "Mark articles as read in Feedly. THIS IS PERMANENT — Feedly has no undo. " +
        "Prefer passing explicit entry_ids. Marking a whole folder can affect " +
        "thousands of articles at once and requires a second setting to be enabled. " +
        (writes.enabled.value
          ? writes.bulkMarkRead.value
            ? "Both are currently enabled."
            : "Article-level marking is enabled; folder-level is not."
          : "Currently disabled in configuration."),
      inputSchema: {
        entry_ids: z
          .array(z.string())
          .optional()
          .describe("Article IDs from get_articles. The safer form — prefer it."),
        folder: z
          .string()
          .optional()
          .describe("Folder name or ID. Marks the whole folder read."),
        older_than: z
          .string()
          .optional()
          .describe(
            'Only with `folder`: a duration like "7d", or a unix-ms timestamp. ' +
              "Omitting it marks the ENTIRE folder read regardless of age — always " +
              "pass this unless the user has explicitly asked to empty the folder. " +
              "Size it against how fast the feeds arrive: a window older than the " +
              "whole backlog marks nothing, which is why a sweep can report zero.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) =>
      toolResult(ctx, async () => {
        const hasEntries = args.entry_ids !== undefined && args.entry_ids.length > 0;

        if (!hasEntries && !args.folder) {
          throw errors.configInvalid(
            "mark_read needs either entry_ids or folder. Refusing to guess what to mark.",
          );
        }
        if (hasEntries && args.folder) {
          throw errors.configInvalid(
            "mark_read takes entry_ids or folder, not both. Call it twice if you mean both.",
          );
        }
        if (!writes.enabled.value) throw errors.writesDisabled(false);

        if (hasEntries) {
          const entryIds = [...new Set(args.entry_ids!)];

          // Feedly documents no ceiling on entryIds, which is not the same as
          // there being none. A silently rejected oversized request would be a
          // permanent operation that looks done and is not, so batch rather than
          // find out. Each batch costs a call, hence the deliberate ceiling.
          const batches: string[][] = [];
          for (let i = 0; i < entryIds.length; i += ENTRY_BATCH_SIZE) {
            batches.push(entryIds.slice(i, i + ENTRY_BATCH_SIZE));
          }

          let sent = 0;
          let failedAfter: string | undefined;
          for (const batch of batches) {
            try {
              await ctx.client.markRead({
                action: "markAsRead",
                type: "entries",
                entryIds: batch,
              });
              sent += batch.length;
            } catch (err) {
              // Say exactly how far it got. "It failed" is useless when the
              // successful part cannot be undone.
              failedAfter = err instanceof Error ? err.message : String(err);
              break;
            }
          }

          ctx.client.invalidateAfterWrite();
          ctx.invalidateFolders();

          return {
            marked: sent,
            requested: entryIds.length,
            ...(entryIds.length !== args.entry_ids!.length && {
              duplicates_removed: args.entry_ids!.length - entryIds.length,
            }),
            ...(batches.length > 1 && { batches: batches.length }),
            scope: `${sent} article${sent === 1 ? "" : "s"} by ID`,
            permanent: true,
            ...(failedAfter && {
              partial: true,
              note:
                `Stopped after ${sent} of ${entryIds.length}. The ones already marked ` +
                `cannot be undone. Cause: ${failedAfter}`,
            }),
            meta: buildMeta(ctx, { fetchedAt: Date.now(), fromCache: false }),
          };
        }

        if (!writes.bulkMarkRead.value) throw errors.writesDisabled(true);

        const { index } = await ctx.folders();
        const folder = resolveFolder(args.folder!, index, ctx.scope);
        const asOf = resolveOlderThan(args.older_than);
        const unreadBefore = folder.unread;

        await ctx.client.markRead({
          action: "markAsRead",
          type: "categories",
          categoryIds: [folder.id],
          asOf,
        });
        ctx.client.invalidateAfterWrite();
        ctx.invalidateFolders();

        // Feedly returns no count for a category-level mark. Reporting the
        // before-count as if it were the result made a sweep that touched
        // nothing read like a five-figure success, so measure the difference
        // instead. Worth one extra call on a permanent operation.
        //
        // The invalidation above has just cleared the cached counts, so this
        // fetch is fresh — and it is stored under the normal TTL rather than
        // discarded. Sweeping several folders in a row otherwise pays for the
        // same counts twice per folder: once to measure, once for the next
        // folders() lookup. That doubling is what put three sweeps over a
        // 15-call session budget.
        let unreadAfter: number | null = null;
        try {
          const after = await ctx.client.unreadCounts(ctx.config.cache.articlesTtlMs.value);
          unreadAfter =
            after.value.unreadcounts?.find((r) => r.id === folder.id)?.count ?? null;
        } catch {
          // Out of budget, or Feedly declined. The write already happened; say
          // we could not measure rather than guessing.
        }

        const marked = unreadAfter === null ? null : Math.max(0, unreadBefore - unreadAfter);

        return {
          marked,
          unread_before: unreadBefore,
          unread_after: unreadAfter,
          scope: `folder:${folder.label}${
            args.older_than ? ` older than ${args.older_than}` : " (ENTIRE FOLDER)"
          }`,
          permanent: true,
          note:
            marked === null
              ? "Feedly returns no count for folder-level marking, and the follow-up " +
                "count could not be read, so how many were affected is unknown. Call " +
                "unread_counts to check."
              : "Feedly returns no count for folder-level marking. `marked` is the " +
                "difference between unread totals read before and immediately after. " +
                "Feedly's counts can lag a moment, so treat it as close, not exact. " +
                (marked === 0
                  ? "Zero means the window matched nothing — everything in this folder " +
                    "is newer than older_than."
                  : ""),
          meta: buildMeta(ctx, { fetchedAt: Date.now(), fromCache: false }),
        };
      }),
  );
}
