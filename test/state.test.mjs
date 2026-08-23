import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cache } from "../dist/cache.js";
import { Budget } from "../dist/budget.js";

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "feedly-mcp-state-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const headers = (o) => new Headers(o);

describe("Cache", () => {
  test("round-trips a value", () => {
    const c = new Cache(dir, "token-a");
    c.set("k", { hello: "world" });
    assert.deepEqual(c.get("k", 60_000).value, { hello: "world" });
  });

  test("reports when the value was stored", () => {
    const c = new Cache(dir, "token-a");
    const before = Date.now();
    c.set("k", 1);
    const hit = c.get("k", 60_000);
    assert.ok(hit.storedAt >= before && hit.storedAt <= Date.now());
  });

  test("a miss is undefined, not a throw", () => {
    assert.equal(new Cache(dir, "t").get("absent", 60_000), undefined);
  });

  test("expires past the TTL", async () => {
    const c = new Cache(dir, "token-a");
    c.set("k", "v");
    assert.ok(c.get("k", 60_000));
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(c.get("k", 10), undefined);
  });

  test("a zero TTL disables reads entirely", () => {
    const c = new Cache(dir, "token-a");
    c.set("k", "v");
    assert.equal(c.get("k", 0), undefined);
  });

  test("survives a new instance — this is the point of it being on disk", () => {
    new Cache(dir, "token-a").set("k", "persisted");
    assert.equal(new Cache(dir, "token-a").get("k", 60_000).value, "persisted");
  });

  test("a different token cannot see the first token's data", () => {
    new Cache(dir, "token-a").set("k", "secret-to-a");
    assert.equal(
      new Cache(dir, "token-b").get("k", 60_000),
      undefined,
      "swapping accounts must not serve the previous account's data",
    );
  });

  test("the token never appears in the path on disk", () => {
    const c = new Cache(dir, "supersecrettoken");
    c.set("k", "v");
    assert.ok(!c.location.includes("supersecrettoken"));
  });

  test("delete removes one entry, leaving others", () => {
    const c = new Cache(dir, "t");
    c.set("a", 1);
    c.set("b", 2);
    c.delete("a");
    assert.equal(c.get("a", 60_000), undefined);
    assert.equal(c.get("b", 60_000).value, 2);
  });

  test("clear removes the namespace", () => {
    const c = new Cache(dir, "t");
    c.set("a", 1);
    c.clear();
    assert.equal(c.get("a", 60_000), undefined);
    assert.equal(existsSync(c.location), false);
  });

  test("deleteMatching removes by logical key, not by filename", () => {
    const c = new Cache(dir, "t");
    c.set("markers-counts", 1);
    c.set("stream:{a}", 2);
    c.set("stream:{b}", 3);
    c.set("subscriptions", 4);

    const removed = c.deleteMatching((k) => k === "markers-counts" || k.startsWith("stream:"));

    assert.equal(removed, 3);
    assert.equal(c.get("markers-counts", 60_000), undefined);
    assert.equal(c.get("stream:{a}", 60_000), undefined);
    assert.equal(c.get("stream:{b}", 60_000), undefined);
    assert.equal(
      c.get("subscriptions", 60_000).value,
      4,
      "metadata must survive — a write does not change the folder list",
    );
  });

  test("deleteMatching on an empty namespace is a no-op", () => {
    assert.equal(new Cache(dir, "never-used").deleteMatching(() => true), 0);
  });

  test("prune drops entries older than the cutoff and keeps fresh ones", async () => {
    const c = new Cache(dir, "t");
    c.set("old", 1);
    await new Promise((r) => setTimeout(r, 25));
    c.set("new", 2);

    c.prune(20);

    assert.equal(c.get("old", 600_000), undefined);
    assert.equal(c.get("new", 600_000).value, 2);
  });

  test("corrupt cache files are treated as a miss", () => {
    const c = new Cache(dir, "t");
    c.set("k", "v");
    for (const f of readdirSync(c.location)) {
      writeFileSync(join(c.location, f), "{not json");
    }
    assert.equal(c.get("k", 60_000), undefined);
  });
});

describe("Budget", () => {
  test("starts clean and allows spending", () => {
    const b = new Budget(new Cache(dir, "t"), 40, 10, 10);
    assert.doesNotThrow(() => b.assertCanSpend());
    assert.equal(b.callsThisSession, 0);
    assert.equal(b.sessionRemaining, 10);
  });

  test("prefers Feedly's own count over local counting", () => {
    const b = new Budget(new Cache(dir, "t"), 40, 10, 10);
    b.record(headers({ "x-ratelimit-count": "37", "x-ratelimit-limit": "50" }));
    const s = b.snapshot();
    assert.equal(s.used, 37, "not 1, which is what local counting would say");
    assert.equal(s.limit, 50);
    assert.equal(s.remaining, 13);
    assert.equal(s.estimated, false);
  });

  test("falls back to local counting before any header is seen", () => {
    const b = new Budget(new Cache(dir, "t"), 40, 10, 10);
    b.record(headers({}));
    const s = b.snapshot();
    assert.equal(s.used, 1);
    assert.equal(s.estimated, true);
  });

  test("carries the reset time through", () => {
    const b = new Budget(new Cache(dir, "t"), 40, 10, 10);
    b.record(headers({ "x-ratelimit-reset": "41655" }));
    assert.equal(b.snapshot().resetSeconds, 41655);
  });

  test("ignores non-numeric headers rather than producing NaN", () => {
    const b = new Budget(new Cache(dir, "t"), 40, 10, 10);
    b.record(headers({ "x-ratelimit-count": "lots" }));
    assert.equal(Number.isFinite(b.snapshot().used), true);
  });

  test("stops at the session ceiling", () => {
    const b = new Budget(new Cache(dir, "t"), 40, 3, 1);
    for (let i = 0; i < 3; i++) b.record(headers({}));
    assert.throws(
      () => b.assertCanSpend(),
      (err) => err.code === "budget_exhausted" && /session/.test(err.message),
    );
  });

  test("stops at the daily ceiling, using Feedly's figure", () => {
    const b = new Budget(new Cache(dir, "t"), 40, 100, 10);
    b.record(headers({ "x-ratelimit-count": "40", "x-ratelimit-limit": "50" }));
    assert.throws(
      () => b.assertCanSpend(),
      (err) => err.code === "budget_exhausted" && /daily/.test(err.message),
    );
  });

  test("the daily error says the count is account-wide, not ours alone", () => {
    const b = new Budget(new Cache(dir, "t"), 5, 100, 1);
    // Feedly says 5 used, but this server only made 1 of them — the rest came
    // from the browser. Claiming we spent the budget would be wrong.
    b.record(headers({ "x-ratelimit-count": "5", "x-ratelimit-limit": "50" }));
    try {
      b.assertCanSpend();
      assert.fail("should have thrown");
    } catch (err) {
      assert.match(err.message, /account-wide/);
      assert.match(err.message, /1 of them through this server/);
      assert.equal(err.details.byThisServer, 1);
    }
  });

  test("tracks how much of the account-wide total is ours", () => {
    const b = new Budget(new Cache(dir, "t"), 40, 10, 10);
    b.record(headers({ "x-ratelimit-count": "30" }));
    b.record(headers({ "x-ratelimit-count": "31" }));
    assert.equal(b.snapshot().used, 31, "account-wide");
    assert.equal(b.callsByThisServerToday, 2, "ours");
  });

  test("daily state persists across instances", () => {
    const cache = new Cache(dir, "t");
    new Budget(cache, 40, 10, 10).record(headers({ "x-ratelimit-count": "22" }));
    assert.equal(new Budget(new Cache(dir, "t"), 40, 10, 10).snapshot().used, 22);
  });

  test("session count does not persist — it is per conversation", () => {
    const cache = new Cache(dir, "t");
    const first = new Budget(cache, 40, 10, 10);
    first.record(headers({}));
    assert.equal(new Budget(new Cache(dir, "t"), 40, 10, 10).callsThisSession, 0);
  });

  test("warns when Feedly's remaining quota is low", () => {
    const b = new Budget(new Cache(dir, "t"), 100, 100, 10);
    b.record(headers({ "x-ratelimit-count": "45", "x-ratelimit-limit": "50" }));
    assert.match(b.warning(), /5 Feedly API calls left/);
  });

  test("warns about the configured ceiling separately from Feedly's", () => {
    const b = new Budget(new Cache(dir, "t"), 20, 100, 10);
    b.record(headers({ "x-ratelimit-count": "15", "x-ratelimit-limit": "500" }));
    const w = b.warning();
    assert.match(w, /daily ceiling of 20/);
    assert.match(w, /account-wide/);
  });

  test("says nothing when there is plenty left", () => {
    const b = new Budget(new Cache(dir, "t"), 40, 10, 5);
    b.record(headers({ "x-ratelimit-count": "2", "x-ratelimit-limit": "50" }));
    assert.equal(b.warning(), undefined);
  });
});
