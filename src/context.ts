/**
 * Shared per-process state: config, token, cache, budget, client.
 *
 * Built once when the server starts. The folder index is memoised for the life
 * of the process because nearly every tool needs it and it is backed by the
 * 24-hour metadata cache anyway.
 */

import { Budget } from "./budget.js";
import { Cache } from "./cache.js";
import { loadConfig, loadToken, type Config } from "./config.js";
import { FeedlyClient } from "./feedly.js";
import { buildFolderIndex, type FolderIndex, type ScopeRules } from "./folders.js";

export interface Context {
  config: Config;
  cache: Cache;
  budget: Budget;
  client: FeedlyClient;
  scope: ScopeRules;
  /** Folder index, fetched on first use and reused after that. */
  folders(): Promise<FolderIndex>;
  /** The account's own ID, needed to build stream IDs. Never hardcoded (spec §5). */
  accountId(): Promise<string>;
  /** Force the next folders() call to refetch — used after a write. */
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
  );
  const client = new FeedlyClient(token, config.feedly.apiBase.value, cache, budget);

  const scope: ScopeRules = {
    includeFolders: config.scope.includeFolders.value,
    excludeFolders: config.scope.excludeFolders.value,
  };

  let pending: Promise<FolderIndex> | undefined;
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
        return buildFolderIndex(categories.value, subscriptions.value, counts?.value, scope);
      })().catch((err: unknown) => {
        pending = undefined; // don't cache a failure
        throw err;
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
