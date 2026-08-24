/**
 * Shared per-process state: config, token, cache, budget, client.
 *
 * The folder index is deliberately *not* memoised for the life of the process.
 * Only concurrent calls are deduplicated; once one settles the next call reads
 * the disk cache again and so respects its TTL. Holding it forever meant a long
 * conversation never saw unread counts change, while still reporting the data as
 * fresh — the freshness fields exist precisely to stop that.
 */

import { Budget } from "./budget.js";
import { Cache } from "./cache.js";
import { loadConfig, loadToken, type Config } from "./config.js";
import { FeedlyClient } from "./feedly.js";
import { buildFolderIndex, type FolderIndex, type ScopeRules } from "./folders.js";

/** A folder index plus an honest account of how old the data behind it is. */
export interface FolderSnapshot {
  index: FolderIndex;
  /** Oldest of the sources it was built from — the conservative claim. */
  fetchedAt: number;
  /**
   * True when *any* source came from cache. The index is built from three
   * requests that can be fresh or stale independently, and the flag exists to
   * warn that the answer is not entirely live — so it aggregates the same
   * conservative way `fetchedAt` does. Using "every" instead would report
   * `false` next to a two-hour-old timestamp.
   */
  fromCache: boolean;
}

export interface Context {
  config: Config;
  cache: Cache;
  budget: Budget;
  client: FeedlyClient;
  scope: ScopeRules;
  /** Folder index with freshness. Concurrent calls share one fetch. */
  folders(): Promise<FolderSnapshot>;
  /** The account's own ID, needed to build stream IDs. Never hardcoded (spec §5). */
  accountId(): Promise<string>;
  /** Drop the in-flight share so the next call re-reads — used after a write. */
  invalidateFolders(): void;
}

export function createContext(configPath?: string): Context {
  const config = loadConfig(configPath);
  const { token } = loadToken(config);

  const cache = new Cache(config.cache.dir.value, token);
  const budget = new Budget(
    cache,
    config.budget.dailyCalls.value,
    config.budget.sessionCalls.value,
    config.budget.warnBelow.value,
    config.budget.sessionIdleResetMs.value,
  );
  const client = new FeedlyClient(token, config.feedly.apiBase.value, cache, budget);

  const scope: ScopeRules = {
    includeFolders: config.scope.includeFolders.value,
    excludeFolders: config.scope.excludeFolders.value,
  };

  let pending: Promise<FolderSnapshot> | undefined;
  let pendingAccount: Promise<string> | undefined;

  const ctx: Context = {
    config,
    cache,
    budget,
    client,
    scope,
    folders() {
      pending ??= (async () => {
        const [categories, subscriptions, counts] = await Promise.all([
          client.categories(config.cache.metadataTtlMs.value),
          client.subscriptions(config.cache.metadataTtlMs.value),
          client.unreadCounts(config.cache.articlesTtlMs.value).catch(() => undefined),
        ]);
        const sources = [categories, subscriptions, ...(counts ? [counts] : [])];
        return {
          index: buildFolderIndex(categories.value, subscriptions.value, counts?.value, scope),
          fetchedAt: Math.min(...sources.map((s) => s.fetchedAt)),
          fromCache: sources.some((s) => s.fromCache),
        };
      })().finally(() => {
        // Share only the in-flight fetch, never the settled result: the next
        // call must go back through the cache so its TTL is honoured.
        pending = undefined;
      });
      return pending;
    },
    accountId() {
      pendingAccount ??= client
        .profile(config.cache.metadataTtlMs.value)
        .then((p) => p.value.id)
        .catch((err: unknown) => {
          pendingAccount = undefined;
          throw err;
        });
      return pendingAccount;
    },
    invalidateFolders() {
      pending = undefined;
    },
  };

  return ctx;
}
