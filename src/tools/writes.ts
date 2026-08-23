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
              "Omit to mark the entire folder read regardless of age.",
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
      toolResult(async () => {
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
          const entryIds = args.entry_ids!;
          await ctx.client.markRead({
            action: "markAsRead",
            type: "entries",
            entryIds,
          });
          ctx.client.invalidateAfterWrite();
          ctx.invalidateFolders();

          return {
            marked: entryIds.length,
            scope: `${entryIds.length} article${entryIds.length === 1 ? "" : "s"} by ID`,
            permanent: true,
            meta: buildMeta(ctx, { fetchedAt: Date.now(), fromCache: false }),
          };
        }

        if (!writes.bulkMarkRead.value) throw errors.writesDisabled(true);

        const { index } = await ctx.folders();
        const folder = resolveFolder(args.folder!, index, ctx.scope);
        const asOf = resolveOlderThan(args.older_than);

        await ctx.client.markRead({
          action: "markAsRead",
          type: "categories",
          categoryIds: [folder.id],
          asOf,
        });
        ctx.client.invalidateAfterWrite();
        ctx.invalidateFolders();

        return {
          // Feedly does not report how many entries a category-level mark hit,
          // so report the folder's last known unread count rather than invent one.
          marked_approximately: folder.unread,
          scope: `folder:${folder.label}${
            args.older_than ? ` older than ${args.older_than}` : " (entire folder)"
          }`,
          permanent: true,
          note:
            "Feedly does not return a count for folder-level marking. The figure is " +
            "the folder's unread count before the call.",
          meta: buildMeta(ctx, { fetchedAt: Date.now(), fromCache: false }),
        };
      }),
  );
}
