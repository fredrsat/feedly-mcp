import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { coverageHours } from "../dist/tools/articles.js";

const NOW = 1_800_000_000_000;
const hoursAgo = (h) => NOW - h * 3_600_000;

describe("coverageHours", () => {
  test("an untruncated result covers the whole window it asked for", () => {
    assert.equal(coverageHours(24, false, hoursAgo(3), NOW), 24);
  });

  test("a truncated result reports how far back it actually reached", () => {
    // The case from the field: asked for 24h, limit hit first, covered 1.7h.
    assert.equal(coverageHours(24, true, hoursAgo(1.7), NOW), 1.7);
  });

  test("rounds to one decimal so the number reads as an estimate", () => {
    assert.equal(coverageHours(24, true, hoursAgo(1.66666), NOW), 1.7);
  });

  test("never claims more coverage than was requested", () => {
    // An article older than the window can appear when Feedly ranks by crawl
    // time rather than publication; it must not inflate the reported window.
    assert.equal(coverageHours(8, true, hoursAgo(40), NOW), 8);
  });

  test("falls back to the requested window when there are no articles", () => {
    assert.equal(coverageHours(12, true, undefined, NOW), 12);
  });

  test("a future timestamp does not produce negative coverage", () => {
    assert.equal(coverageHours(12, true, NOW + 3_600_000, NOW), 12);
  });

  test("a zero or garbage timestamp falls back rather than reporting 500000h", () => {
    assert.equal(coverageHours(12, true, 0, NOW), 12);
    assert.equal(coverageHours(12, true, NaN, NOW), 12);
  });

  test("sub-hour coverage is still reported, not rounded to zero", () => {
    assert.equal(coverageHours(24, true, hoursAgo(0.4), NOW), 0.4);
  });
});
