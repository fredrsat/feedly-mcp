/**
 * Configuration: environment variable → config file → built-in default (spec §4.1).
 *
 * Environment variables must cover every setting, not just the token — the MCP
 * bundle in spec §2.2 has no other way in. Every resolved value carries its
 * source so `doctor` can show where a surprising value came from.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { errors } from "./errors.js";

/** Feedly silently returns nothing past 31 days, so clamp rather than pass through. */
export const MAX_HOURS = 744;

export type Source = "env" | "file" | "default";

export interface Resolved<T> {
  value: T;
  source: Source;
  /** The env var or TOML key this could be set with. */
  key: string;
}

export interface Config {
  feedly: {
    tokenFile: Resolved<string>;
    apiBase: Resolved<string>;
  };
  scope: {
    includeFolders: Resolved<string[]>;
    excludeFolders: Resolved<string[]>;
    defaultFolder: Resolved<string | undefined>;
  };
  defaults: {
    hours: Resolved<number>;
    limit: Resolved<number>;
    unreadOnly: Resolved<boolean>;
    summaryChars: Resolved<number>;
    fullText: Resolved<boolean>;
  };
  budget: {
    dailyCalls: Resolved<number>;
    sessionCalls: Resolved<number>;
    sessionIdleResetMs: Resolved<number>;
    warnBelow: Resolved<number>;
  };
  cache: {
    metadataTtlMs: Resolved<number>;
    articlesTtlMs: Resolved<number>;
    dir: Resolved<string>;
  };
  writes: {
    enabled: Resolved<boolean>;
    bulkMarkRead: Resolved<boolean>;
  };
  /** Where the config file was read from, or null if none existed. */
  configPath: string | null;
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function xdg(envVar: string, fallback: string): string {
  const base = process.env[envVar];
  return base ? join(base, "feedly-mcp") : expandHome(fallback);
}

export function defaultConfigPath(): string {
  return join(xdg("XDG_CONFIG_HOME", "~/.config/feedly-mcp"), "config.toml");
}

/** "90s" | "15m" | "6h" | "1d" → milliseconds. */
export function parseDuration(input: string, key: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(input.trim());
  if (!m) {
    throw errors.configInvalid(
      `${key}: "${input}" is not a duration. Use a number followed by ms, s, m, h or d — for example "15m" or "24h".`,
    );
  }
  const n = Number(m[1]);
  const unit = m[2] as "ms" | "s" | "m" | "h" | "d";
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return n * factor;
}

function envName(section: string, key: string): string {
  return `FEEDLY_MCP_${section.toUpperCase()}_${key.toUpperCase()}`;
}

type Kind = "string" | "number" | "boolean" | "list" | "duration" | "path";

interface FileTable {
  [section: string]: Record<string, unknown> | undefined;
}

function resolveOne<T>(
  file: FileTable,
  section: string,
  key: string,
  kind: Kind,
  fallback: T,
): Resolved<T> {
  const env = envName(section, key);
  const raw = process.env[env];
  const tomlKey = `${section}.${key}`;

  if (raw !== undefined && raw !== "") {
    return { value: coerce(raw, kind, env) as T, source: "env", key: env };
  }

  const fromFile = file[section]?.[key];
  if (fromFile !== undefined) {
    return { value: coerceParsed(fromFile, kind, tomlKey) as T, source: "file", key: tomlKey };
  }

  return { value: fallback, source: "default", key: tomlKey };
}

function coerce(raw: string, kind: Kind, key: string): unknown {
  switch (kind) {
    case "string":
      return raw;
    case "path":
      return expandHome(raw);
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw errors.configInvalid(`${key}: "${raw}" is not a number.`);
      }
      return n;
    }
    case "boolean": {
      const v = raw.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(v)) return true;
      if (["0", "false", "no", "off"].includes(v)) return false;
      throw errors.configInvalid(`${key}: "${raw}" is not a boolean. Use true or false.`);
    }
    case "list":
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    case "duration":
      return parseDuration(raw, key);
  }
}

function coerceParsed(value: unknown, kind: Kind, key: string): unknown {
  switch (kind) {
    case "string":
      if (typeof value !== "string") throw errors.configInvalid(`${key}: expected a string.`);
      return value;
    case "path":
      if (typeof value !== "string") throw errors.configInvalid(`${key}: expected a path string.`);
      return expandHome(value);
    case "number":
      if (typeof value !== "number") throw errors.configInvalid(`${key}: expected a number.`);
      return value;
    case "boolean":
      if (typeof value !== "boolean")
        throw errors.configInvalid(`${key}: expected true or false.`);
      return value;
    case "list":
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        throw errors.configInvalid(`${key}: expected a list of strings.`);
      }
      return value as string[];
    case "duration":
      if (typeof value !== "string")
        throw errors.configInvalid(`${key}: expected a duration string like "24h".`);
      return parseDuration(value, key);
  }
}

export function loadConfig(configPathOverride?: string): Config {
  const path = configPathOverride ? resolve(expandHome(configPathOverride)) : defaultConfigPath();

  let file: FileTable = {};
  let configPath: string | null = null;

  try {
    const text = readFileSync(path, "utf8");
    const parsed = parseToml(text);
    if (typeof parsed !== "object" || parsed === null) {
      throw errors.configInvalid(`${path}: expected a TOML table at the top level.`);
    }
    file = parsed as FileTable;
    configPath = path;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") {
      if (configPathOverride || e.code !== "EACCES") {
        throw errors.configInvalid(`Could not read ${path}: ${e.message}`);
      }
    }
    // No config file is the normal case — defaults apply.
  }

  if (file["feedly"] && "token" in file["feedly"]) {
    throw errors.configInvalid(
      `${path}: there is no "token" setting, deliberately. Config files get copied ` +
        `into dotfile repos and pasted into issues. Use the FEEDLY_TOKEN environment ` +
        `variable, or feedly.token_file pointing at a 0600 file.`,
    );
  }

  const cfg: Config = {
    feedly: {
      tokenFile: resolveOne(
        file,
        "feedly",
        "token_file",
        "path",
        join(xdg("XDG_CONFIG_HOME", "~/.config/feedly-mcp"), "token"),
      ),
      apiBase: resolveOne(file, "feedly", "api_base", "string", "https://api.feedly.com"),
    },
    scope: {
      includeFolders: resolveOne<string[]>(file, "scope", "include_folders", "list", []),
      excludeFolders: resolveOne<string[]>(file, "scope", "exclude_folders", "list", []),
      defaultFolder: resolveOne<string | undefined>(
        file,
        "scope",
        "default_folder",
        "string",
        undefined,
      ),
    },
    defaults: {
      hours: resolveOne(file, "defaults", "hours", "number", 8),
      limit: resolveOne(file, "defaults", "limit", "number", 100),
      unreadOnly: resolveOne(file, "defaults", "unread_only", "boolean", true),
      summaryChars: resolveOne(file, "defaults", "summary_chars", "number", 400),
      fullText: resolveOne(file, "defaults", "full_text", "boolean", false),
    },
    budget: {
      dailyCalls: resolveOne(file, "budget", "daily_calls", "number", 40),
      sessionCalls: resolveOne(file, "budget", "session_calls", "number", 15),
      sessionIdleResetMs: resolveOne(
        file,
        "budget",
        "session_idle_reset",
        "duration",
        15 * 60_000,
      ),
      warnBelow: resolveOne(file, "budget", "warn_below", "number", 10),
    },
    cache: {
      metadataTtlMs: resolveOne(file, "cache", "metadata_ttl", "duration", 24 * 3_600_000),
      articlesTtlMs: resolveOne(file, "cache", "articles_ttl", "duration", 15 * 60_000),
      dir: resolveOne(file, "cache", "dir", "path", xdg("XDG_CACHE_HOME", "~/.cache/feedly-mcp")),
    },
    writes: {
      enabled: resolveOne(file, "writes", "enabled", "boolean", false),
      bulkMarkRead: resolveOne(file, "writes", "bulk_mark_read", "boolean", false),
    },
    configPath,
  };

  validate(cfg);
  return cfg;
}

function validate(cfg: Config): void {
  const positive: Array<[string, number]> = [
    [cfg.defaults.hours.key, cfg.defaults.hours.value],
    [cfg.defaults.limit.key, cfg.defaults.limit.value],
    [cfg.defaults.summaryChars.key, cfg.defaults.summaryChars.value],
    [cfg.budget.dailyCalls.key, cfg.budget.dailyCalls.value],
    [cfg.budget.sessionCalls.key, cfg.budget.sessionCalls.value],
  ];
  for (const [key, value] of positive) {
    if (!(value > 0)) throw errors.configInvalid(`${key}: must be greater than 0 (got ${value}).`);
  }
  if (cfg.defaults.limit.value > 1000) {
    throw errors.configInvalid(
      `${cfg.defaults.limit.key}: ${cfg.defaults.limit.value} is unreasonably large; a single ` +
        `response would swamp the context window. Keep it at or below 1000.`,
    );
  }
  if (cfg.writes.bulkMarkRead.value && !cfg.writes.enabled.value) {
    throw errors.configInvalid(
      `${cfg.writes.bulkMarkRead.key} is true but ${cfg.writes.enabled.key} is false. ` +
        `Folder-level marking requires both.`,
    );
  }
}

/** Clamp to Feedly's 31-day ceiling, reporting whether it bit (spec §11). */
export function clampHours(hours: number): { hours: number; clamped: boolean } {
  if (hours > MAX_HOURS) return { hours: MAX_HOURS, clamped: true };
  if (hours < 1) return { hours: 1, clamped: true };
  return { hours, clamped: false };
}

export interface LoadedToken {
  token: string;
  /** Human-readable provenance, safe to print. Never the token itself. */
  source: string;
}

export function loadToken(cfg: Config): LoadedToken {
  const fromEnv = process.env["FEEDLY_TOKEN"];
  if (fromEnv && fromEnv.trim() !== "") {
    return { token: fromEnv.trim(), source: "environment variable FEEDLY_TOKEN" };
  }

  const path = cfg.feedly.tokenFile.value;
  try {
    const stat = statSync(path);
    const mode = stat.mode & 0o777;
    if (mode & 0o077) {
      throw errors.tokenFilePermissions(path, `0${mode.toString(8)}`);
    }
    const token = readFileSync(path, "utf8").trim();
    if (token === "") throw errors.tokenMissing(["FEEDLY_TOKEN", `${path} (empty)`]);
    return { token, source: `file ${path}` };
  } catch (err) {
    if (err instanceof Error && err.name === "FeedlyMcpError") throw err;
    throw errors.tokenMissing(["FEEDLY_TOKEN", path]);
  }
}
