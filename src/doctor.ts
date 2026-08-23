/**
 * `feedly-mcp doctor` (spec §9).
 *
 * Build step 1 of §10 turned into a command: it proves the whole chain before
 * the user has asked Claude anything, and it prints the folder IDs they need in
 * order to fill in `scope`. It never prints the token.
 */

import { Budget } from "./budget.js";
import { Cache } from "./cache.js";
import { clampHours, loadConfig, loadToken, type Config, type Resolved } from "./config.js";
import { FeedlyClient } from "./feedly.js";
import { buildFolderIndex, isVisible, unmatchedScopeEntries } from "./folders.js";
import { FeedlyMcpError, formatDuration } from "./errors.js";

const ok = (s: string) => `[32m✓[0m ${s}`;
const bad = (s: string) => `[31m✗[0m ${s}`;
const warn = (s: string) => `[33m![0m ${s}`;
const dim = (s: string) => `[2m${s}[0m`;

export interface DoctorOptions {
  configPath?: string;
  refresh?: boolean;
  verbose?: boolean;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<number> {
  const out = (s = "") => process.stdout.write(`${s}\n`);

  let config: Config;
  try {
    config = loadConfig(opts.configPath);
  } catch (err) {
    out(bad(message(err)));
    return 1;
  }

  out(
    ok(
      `Config ${
        config.configPath ? `loaded from ${config.configPath}` : "using built-in defaults"
      }`,
    ),
  );

  const overrides = collectNonDefaults(config);
  if (overrides.length > 0) {
    for (const line of overrides) out(dim(`    ${line}`));
  }
  out();

  let token: string;
  try {
    const loaded = loadToken(config);
    token = loaded.token;
    out(ok(`Token found        ${dim(`(${loaded.source})`)}`));
  } catch (err) {
    out(bad(message(err)));
    return 1;
  }

  const cache = new Cache(config.cache.dir.value, token);
  if (opts.refresh) {
    cache.clear();
    out(ok(`Cache cleared      ${dim(cache.location)}`));
  }

  const budget = new Budget(
    cache,
    config.budget.dailyCalls.value,
    config.budget.sessionCalls.value,
    config.budget.warnBelow.value,
  );
  const client = new FeedlyClient(token, config.feedly.apiBase.value, cache, budget);

  try {
    const profile = await client.profile(config.cache.metadataTtlMs.value);
    const who = profile.value.email ?? profile.value.fullName ?? profile.value.id;
    out(ok(`Connected to Feedly ${dim(`${who}${cached(profile.fromCache)}`)}`));
    if (profile.value.product) out(dim(`    plan: ${profile.value.product}`));

    const [categories, subscriptions, counts] = await Promise.all([
      client.categories(config.cache.metadataTtlMs.value),
      client.subscriptions(config.cache.metadataTtlMs.value),
      client.unreadCounts(config.cache.articlesTtlMs.value).catch(() => undefined),
    ]);

    const scope = {
      includeFolders: config.scope.includeFolders.value,
      excludeFolders: config.scope.excludeFolders.value,
    };
    const index = buildFolderIndex(
      categories.value,
      subscriptions.value,
      counts?.value,
      scope,
    );

    const hidden = index.all.length - index.visible.length;
    out(
      ok(
        `${index.all.length} folders, ${subscriptions.value.length} feeds` +
          (hidden > 0 ? dim(`  (${hidden} hidden by scope)`) : ""),
      ),
    );
    out();

    const rows = index.all.map((f) => ({
      label: f.label,
      feeds: `${f.feedCount} feed${f.feedCount === 1 ? "" : "s"}`,
      unread: f.unread > 0 ? `${f.unread} unread` : "",
      id: f.id,
      visible: isVisible(f, scope),
    }));
    const w1 = Math.max(...rows.map((r) => r.label.length), 6);
    const w2 = Math.max(...rows.map((r) => r.feeds.length), 5);
    const w3 = Math.max(...rows.map((r) => r.unread.length), 0);

    for (const r of rows) {
      const line =
        `  ${r.label.padEnd(w1)}  ${r.feeds.padStart(w2)}  ${r.unread.padStart(w3)}  ` +
        dim(r.id);
      out(r.visible ? line : dim(`  ${r.label.padEnd(w1)}  ${"— out of scope".padStart(w2)}`));
    }
    out();

    const unmatched = unmatchedScopeEntries(index.all, scope);
    if (unmatched.length > 0) {
      out(
        warn(
          `These scope entries match no folder: ${unmatched.join(", ")}. ` +
            `Check for a typo — a scope that matches nothing hides everything.`,
        ),
      );
    }
    if (config.scope.defaultFolder.value) {
      const d = config.scope.defaultFolder.value;
      const found = index.all.find(
        (f) => f.id === d || f.label.toLowerCase() === d.toLowerCase(),
      );
      if (!found) {
        out(warn(`scope.default_folder is "${d}", which matches no folder.`));
      } else if (!isVisible(found, scope)) {
        out(warn(`scope.default_folder "${d}" is excluded by scope.`));
      }
    }

    const snap = budget.snapshot();
    const limitText = snap.limit !== undefined ? ` of ${snap.limit}` : "";
    const resetText =
      snap.resetSeconds !== undefined
        ? dim(`   (resets in ${formatDuration(snap.resetSeconds)})`)
        : "";
    out(
      `  API calls used today: ${snap.used}${limitText}${
        snap.estimated ? dim(" (estimated)") : ""
      }${resetText}`,
    );
    out(
      dim(
        `  Configured ceiling:   ${config.budget.dailyCalls.value}/day account-wide, ` +
          `${config.budget.sessionCalls.value}/session`,
      ),
    );
    out(
      dim(
        `  Through this server:  ${budget.callsByThisServerToday} today, ` +
          `${budget.callsThisSession} in this run`,
      ),
    );

    if (snap.limit !== undefined && snap.limit < config.budget.dailyCalls.value) {
      out();
      out(
        warn(
          `Feedly reports a ceiling of ${snap.limit} calls/day, but budget.daily_calls is ` +
            `${config.budget.dailyCalls.value}. Lower it so you hit a clean local error ` +
            `instead of Feedly's 429.`,
        ),
      );
    }

    const w = budget.warning();
    if (w) {
      out();
      out(warn(w));
    }

    if (opts.verbose) {
      out();
      out(dim("  Resolved configuration:"));
      for (const line of collectAll(config)) out(dim(`    ${line}`));
    }

    out();
    out(ok("Everything checks out."));
    return 0;
  } catch (err) {
    out();
    out(bad(message(err)));
    if (err instanceof FeedlyMcpError && err.code === "rate_limited") {
      out(dim("  Nothing was retried — that would only extend the block."));
    }
    return 1;
  }
}

function cached(fromCache: boolean): string {
  return fromCache ? " — from cache" : "";
}

function message(err: unknown): string {
  if (err instanceof FeedlyMcpError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function fmt(r: Resolved<unknown>): string {
  const v = Array.isArray(r.value) ? `[${r.value.join(", ")}]` : String(r.value);
  return `${r.key} = ${v === "undefined" ? "(unset)" : v}  ${dim(`← ${r.source}`)}`;
}

function everySetting(config: Config): Array<Resolved<unknown>> {
  return [
    config.feedly.tokenFile,
    config.feedly.apiBase,
    config.scope.includeFolders,
    config.scope.excludeFolders,
    config.scope.defaultFolder,
    config.defaults.hours,
    config.defaults.limit,
    config.defaults.unreadOnly,
    config.defaults.summaryChars,
    config.defaults.fullText,
    config.budget.dailyCalls,
    config.budget.sessionCalls,
    config.budget.warnBelow,
    config.cache.metadataTtlMs,
    config.cache.articlesTtlMs,
    config.cache.dir,
    config.writes.enabled,
    config.writes.bulkMarkRead,
  ];
}

function collectNonDefaults(config: Config): string[] {
  const lines = everySetting(config)
    .filter((r) => r.source !== "default")
    .map(fmt);

  const { hours, clamped } = clampHours(config.defaults.hours.value);
  if (clamped) {
    lines.push(
      `defaults.hours clamped to ${hours} — Feedly returns nothing past 31 days`,
    );
  }
  if (config.writes.enabled.value) {
    lines.push(
      `writes are ENABLED${
        config.writes.bulkMarkRead.value ? ", including whole-folder marking" : ""
      } — mark_read is permanent`,
    );
  }
  return lines;
}

function collectAll(config: Config): string[] {
  return everySetting(config).map(fmt);
}
