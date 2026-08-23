import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, loadToken, parseDuration, clampHours, MAX_HOURS } from "../dist/config.js";

let dir;
let saved;

const FEEDLY_ENV = (key) => key === "FEEDLY_TOKEN" || key.startsWith("FEEDLY_MCP_");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feedly-mcp-test-"));
  saved = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (FEEDLY_ENV(key)) delete process.env[key];
  }
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (FEEDLY_ENV(key)) delete process.env[key];
  }
  for (const [k, v] of Object.entries(saved)) {
    if (FEEDLY_ENV(k)) process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(body) {
  const p = join(dir, "config.toml");
  writeFileSync(p, body);
  return p;
}

describe("parseDuration", () => {
  test("accepts the documented units", () => {
    assert.equal(parseDuration("500ms", "k"), 500);
    assert.equal(parseDuration("90s", "k"), 90_000);
    assert.equal(parseDuration("15m", "k"), 900_000);
    assert.equal(parseDuration("24h", "k"), 86_400_000);
    assert.equal(parseDuration("1d", "k"), 86_400_000);
  });

  test("tolerates surrounding whitespace", () => {
    assert.equal(parseDuration("  6h  ", "k"), 21_600_000);
  });

  test("rejects garbage with a message naming the key", () => {
    assert.throws(() => parseDuration("soon", "cache.metadata_ttl"), /cache\.metadata_ttl/);
    assert.throws(() => parseDuration("6", "k"), /not a duration/);
    assert.throws(() => parseDuration("6 hours", "k"), /not a duration/);
  });
});

describe("clampHours", () => {
  test("passes reasonable values through untouched", () => {
    assert.deepEqual(clampHours(8), { hours: 8, clamped: false });
    assert.deepEqual(clampHours(MAX_HOURS), { hours: MAX_HOURS, clamped: false });
  });

  test("clamps past Feedly's 31-day ceiling and says so", () => {
    assert.deepEqual(clampHours(5000), { hours: MAX_HOURS, clamped: true });
  });

  test("clamps nonsense at the low end too", () => {
    assert.deepEqual(clampHours(0), { hours: 1, clamped: true });
    assert.deepEqual(clampHours(-5), { hours: 1, clamped: true });
  });
});

describe("loadConfig precedence", () => {
  test("built-in defaults match the documented values", () => {
    const c = loadConfig(join(dir, "does-not-exist.toml"));
    assert.equal(c.defaults.hours.value, 8);
    assert.equal(c.defaults.limit.value, 100);
    assert.equal(c.defaults.unreadOnly.value, true);
    assert.equal(c.defaults.summaryChars.value, 400);
    assert.equal(c.defaults.fullText.value, false);
    assert.equal(c.budget.dailyCalls.value, 40);
    assert.equal(c.budget.sessionCalls.value, 10);
    assert.equal(c.budget.warnBelow.value, 10);
    assert.equal(c.cache.metadataTtlMs.value, 86_400_000);
    assert.equal(c.cache.articlesTtlMs.value, 900_000);
    assert.equal(c.writes.enabled.value, false);
    assert.equal(c.writes.bulkMarkRead.value, false);
  });

  test("a missing config file is not an error", () => {
    const c = loadConfig(join(dir, "nope.toml"));
    assert.equal(c.configPath, null);
    assert.equal(c.defaults.hours.source, "default");
  });

  test("file values win over defaults", () => {
    const p = writeConfig(`[defaults]\nhours = 24\n`);
    const c = loadConfig(p);
    assert.equal(c.defaults.hours.value, 24);
    assert.equal(c.defaults.hours.source, "file");
    assert.equal(c.configPath, p);
  });

  test("env wins over file — the bundle's only way in", () => {
    const p = writeConfig(`[defaults]\nhours = 24\n`);
    process.env.FEEDLY_MCP_DEFAULTS_HOURS = "48";
    const c = loadConfig(p);
    assert.equal(c.defaults.hours.value, 48);
    assert.equal(c.defaults.hours.source, "env");
    assert.equal(c.defaults.hours.key, "FEEDLY_MCP_DEFAULTS_HOURS");
  });

  test("an empty env var does not override the file", () => {
    const p = writeConfig(`[defaults]\nhours = 24\n`);
    process.env.FEEDLY_MCP_DEFAULTS_HOURS = "";
    assert.equal(loadConfig(p).defaults.hours.value, 24);
  });

  test("lists come from env as comma-separated", () => {
    process.env.FEEDLY_MCP_SCOPE_INCLUDE_FOLDERS = "AI, Longform ,Science";
    const c = loadConfig(join(dir, "none.toml"));
    assert.deepEqual(c.scope.includeFolders.value, ["AI", "Longform", "Science"]);
  });

  test("lists come from file as TOML arrays", () => {
    const p = writeConfig(`[scope]\ninclude_folders = ["AI", "Science"]\n`);
    assert.deepEqual(loadConfig(p).scope.includeFolders.value, ["AI", "Science"]);
  });

  test("booleans accept the usual spellings", () => {
    for (const [raw, expected] of [
      ["true", true],
      ["1", true],
      ["yes", true],
      ["on", true],
      ["false", false],
      ["0", false],
      ["no", false],
      ["off", false],
    ]) {
      process.env.FEEDLY_MCP_WRITES_ENABLED = raw;
      assert.equal(loadConfig(join(dir, "n.toml")).writes.enabled.value, expected, raw);
    }
  });

  test("durations are parsed from either source", () => {
    const p = writeConfig(`[cache]\nmetadata_ttl = "2h"\n`);
    assert.equal(loadConfig(p).cache.metadataTtlMs.value, 7_200_000);
    process.env.FEEDLY_MCP_CACHE_METADATA_TTL = "30m";
    assert.equal(loadConfig(p).cache.metadataTtlMs.value, 1_800_000);
  });
});

describe("loadConfig validation", () => {
  test("refuses a token in the config file", () => {
    const p = writeConfig(`[feedly]\ntoken = "secret"\n`);
    assert.throws(() => loadConfig(p), /no "token" setting/);
  });

  test("rejects non-numeric numbers", () => {
    process.env.FEEDLY_MCP_DEFAULTS_HOURS = "eight";
    assert.throws(() => loadConfig(join(dir, "n.toml")), /not a number/);
  });

  test("rejects a wrong type from the file", () => {
    const p = writeConfig(`[defaults]\nhours = "eight"\n`);
    assert.throws(() => loadConfig(p), /expected a number/);
  });

  test("rejects zero and negative ceilings", () => {
    process.env.FEEDLY_MCP_BUDGET_DAILY_CALLS = "0";
    assert.throws(() => loadConfig(join(dir, "n.toml")), /greater than 0/);
  });

  test("rejects an absurd limit that would swamp the context window", () => {
    process.env.FEEDLY_MCP_DEFAULTS_LIMIT = "50000";
    assert.throws(() => loadConfig(join(dir, "n.toml")), /unreasonably large/);
  });

  test("bulk_mark_read without writes.enabled is refused", () => {
    const p = writeConfig(`[writes]\nenabled = false\nbulk_mark_read = true\n`);
    assert.throws(() => loadConfig(p), /requires both/);
  });

  test("both write switches on together is accepted", () => {
    const p = writeConfig(`[writes]\nenabled = true\nbulk_mark_read = true\n`);
    const c = loadConfig(p);
    assert.equal(c.writes.bulkMarkRead.value, true);
  });

  test("malformed TOML is reported against the path", () => {
    const p = writeConfig(`[defaults\nhours = 8\n`);
    assert.throws(() => loadConfig(p), new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("loadToken", () => {
  test("prefers the environment variable and reports where it came from", () => {
    process.env.FEEDLY_TOKEN = "  abc123  ";
    const { token, source } = loadToken(loadConfig(join(dir, "n.toml")));
    assert.equal(token, "abc123", "surrounding whitespace is trimmed");
    assert.match(source, /FEEDLY_TOKEN/);
  });

  test("never puts the token in the source string", () => {
    process.env.FEEDLY_TOKEN = "supersecret";
    const { source } = loadToken(loadConfig(join(dir, "n.toml")));
    assert.ok(!source.includes("supersecret"));
  });

  test("falls back to a 0600 token file", () => {
    const tokenPath = join(dir, "token");
    writeFileSync(tokenPath, "filetoken\n");
    chmodSync(tokenPath, 0o600);
    const p = writeConfig(`[feedly]\ntoken_file = "${tokenPath}"\n`);
    const { token, source } = loadToken(loadConfig(p));
    assert.equal(token, "filetoken");
    assert.match(source, /token/);
  });

  test("refuses a group- or world-readable token file", () => {
    const tokenPath = join(dir, "token");
    writeFileSync(tokenPath, "filetoken\n");
    chmodSync(tokenPath, 0o644);
    const p = writeConfig(`[feedly]\ntoken_file = "${tokenPath}"\n`);
    assert.throws(() => loadToken(loadConfig(p)), /chmod 600/);
  });

  test("says where it looked when there is no token at all", () => {
    const p = writeConfig(`[feedly]\ntoken_file = "${join(dir, "absent")}"\n`);
    assert.throws(() => loadToken(loadConfig(p)), /FEEDLY_TOKEN/);
  });

  test("an empty token file counts as missing", () => {
    const tokenPath = join(dir, "token");
    writeFileSync(tokenPath, "   \n");
    chmodSync(tokenPath, 0o600);
    const p = writeConfig(`[feedly]\ntoken_file = "${tokenPath}"\n`);
    assert.throws(() => loadToken(loadConfig(p)), /No Feedly token/);
  });
});
