/**
 * Folder resolution and scope enforcement (spec §4.3, §5).
 *
 * Folder IDs are either a readable label or a UUID depending on how old the
 * folder is, so never assume either — everything is resolved against the list
 * from /v3/categories. The agent addresses folders by name; UUIDs stay internal.
 */

import type { Category, Subscription, UnreadCounts } from "./feedly.js";
import { errors } from "./errors.js";

export interface FolderInfo {
  id: string;
  label: string;
  feedCount: number;
  unread: number;
}

export interface ScopeRules {
  includeFolders: string[];
  excludeFolders: string[];
}

export interface FolderIndex {
  all: FolderInfo[];
  /** Only the folders the agent is allowed to see. */
  visible: FolderInfo[];
  /** Feed stream ID → labels of every folder it belongs to. */
  feedFolders: Map<string, string[]>;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** A folder matches a scope entry by exact ID or case-insensitive label. */
function matches(folder: FolderInfo, entry: string): boolean {
  return folder.id === entry.trim() || norm(folder.label) === norm(entry);
}

export function buildFolderIndex(
  categories: Category[],
  subscriptions: Subscription[],
  counts: UnreadCounts | undefined,
  scope: ScopeRules,
): FolderIndex {
  const unreadById = new Map<string, number>();
  for (const c of counts?.unreadcounts ?? []) unreadById.set(c.id, c.count);

  const feedCounts = new Map<string, number>();
  const feedFolders = new Map<string, string[]>();

  for (const sub of subscriptions) {
    const labels: string[] = [];
    for (const cat of sub.categories ?? []) {
      feedCounts.set(cat.id, (feedCounts.get(cat.id) ?? 0) + 1);
      labels.push(cat.label);
    }
    feedFolders.set(sub.id, labels);
  }

  const all: FolderInfo[] = categories.map((c) => ({
    id: c.id,
    label: c.label,
    feedCount: feedCounts.get(c.id) ?? 0,
    unread: unreadById.get(c.id) ?? 0,
  }));

  const visible = all.filter((f) => isVisible(f, scope));

  return { all, visible, feedFolders };
}

export function isVisible(folder: FolderInfo, scope: ScopeRules): boolean {
  if (scope.excludeFolders.some((e) => matches(folder, e))) return false;
  if (scope.includeFolders.length === 0) return true;
  return scope.includeFolders.some((e) => matches(folder, e));
}

/**
 * Resolve what the agent asked for into a stream ID it is allowed to read.
 *
 * Scope is enforced here rather than only when listing, so passing a raw ID
 * learned elsewhere does not get around it (spec §4.3).
 */
export function resolveFolder(input: string, index: FolderIndex, scope: ScopeRules): FolderInfo {
  const found = index.all.find((f) => matches(f, input));

  if (!found) {
    throw errors.folderNotFound(
      input,
      index.visible.map((f) => f.label),
    );
  }
  if (!isVisible(found, scope)) {
    throw errors.outOfScope(found.label);
  }
  return found;
}

/**
 * Scope entries that match no real folder. Almost always a typo, and worth
 * saying out loud in `doctor` rather than silently hiding everything.
 */
export function unmatchedScopeEntries(all: FolderInfo[], scope: ScopeRules): string[] {
  const entries = [...scope.includeFolders, ...scope.excludeFolders];
  return entries.filter((e) => !all.some((f) => matches(f, e)));
}
