import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../dist/errors.js";

describe("redact", () => {
  test("replaces every occurrence of the token", () => {
    const out = redact("failed for abc123secret and abc123secret", "abc123secret");
    assert.ok(!out.includes("abc123secret"));
    assert.equal(out.match(/<token redacted>/g).length, 2);
  });

  test("finds the token inside JSON, which is how a result is serialised", () => {
    const body = JSON.stringify({ error: "boom", url: "https://x/?auth=abc123secret" });
    assert.ok(!redact(body, "abc123secret").includes("abc123secret"));
  });

  test("leaves text alone when the token does not appear", () => {
    assert.equal(redact("nothing to see", "abc123secret"), "nothing to see");
  });

  test("does nothing without a token, rather than throwing", () => {
    assert.equal(redact("text", undefined), "text");
  });

  test("ignores implausibly short tokens so it cannot shred normal text", () => {
    // Redacting on a 3-character value would mangle every message containing it.
    assert.equal(redact("a cat sat on a mat", "at"), "a cat sat on a mat");
  });
});
