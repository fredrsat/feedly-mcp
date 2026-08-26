import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fitToBudget, MAX_LIMIT } from "../dist/tools/articles.js";

const article = (i, summaryLen = 400) => ({
  id: `e${i}`, title: `Title ${i}`, source: "r/x", url: "https://example.com/a",
  published: 1755800000000, folders: ["AI"], engagement: 0,
  summary: "x".repeat(summaryLen),
});

describe("fitToBudget", () => {
  test("leaves a small payload untouched", () => {
    const items = Array.from({ length: 5 }, (_, i) => article(i));
    const { kept, dropped } = fitToBudget(items, 100_000);
    assert.equal(kept.length, 5);
    assert.equal(dropped, 0);
  });

  test("trims a payload that would be spilled to a file", () => {
    // 400 articles at full summary length is the shape that produced 308 KB.
    const items = Array.from({ length: 400 }, (_, i) => article(i));
    assert.ok(Buffer.byteLength(JSON.stringify(items)) > 100_000, "fixture must be oversized");

    const { kept, dropped } = fitToBudget(items, 100_000);
    assert.ok(Buffer.byteLength(JSON.stringify(kept)) <= 100_000);
    assert.equal(kept.length + dropped, 400);
    assert.ok(kept.length > 0);
  });

  test("keeps the newest, since the list is already sorted", () => {
    const items = Array.from({ length: 400 }, (_, i) => article(i));
    const { kept } = fitToBudget(items, 100_000);
    assert.equal(kept[0].id, "e0", "trims from the tail, not the head");
  });

  test("long summaries mean fewer articles fit — count alone is not enough", () => {
    const short = Array.from({ length: 200 }, (_, i) => article(i, 100));
    const long = Array.from({ length: 200 }, (_, i) => article(i, 2000));
    assert.ok(fitToBudget(short, 50_000).kept.length > fitToBudget(long, 50_000).kept.length);
  });

  test("never trims below one article", () => {
    const { kept } = fitToBudget([article(0, 500_000)], 1000);
    assert.equal(kept.length, 1, "an oversized single article is better than nothing");
  });

  test("the hard limit is documented and low enough to matter", () => {
    assert.equal(MAX_LIMIT, 200);
  });
});
