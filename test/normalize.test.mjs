import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { stripHtml, trimTo, normalizeArticle, dedupe } from "../dist/normalize.js";

describe("stripHtml", () => {
  test("removes tags", () => {
    assert.equal(stripHtml("<p>Hello <b>world</b></p>"), "Hello world");
  });

  test("drops script and style bodies, not just their tags", () => {
    assert.equal(stripHtml("a<script>var x = 1 < 2;</script>b"), "a b");
    assert.equal(stripHtml("a<style>.x { color: red }</style>b"), "a b");
  });

  test("inserts space at block boundaries so words do not fuse", () => {
    assert.equal(stripHtml("<p>one</p><p>two</p>"), "one two");
    assert.equal(stripHtml("<li>a</li><li>b</li>"), "a b");
    assert.equal(stripHtml("one<br>two"), "one two");
  });

  test("decodes named entities", () => {
    assert.equal(stripHtml("A &amp; B &lt;tag&gt; &quot;q&quot;"), 'A & B <tag> "q"');
    assert.equal(stripHtml("caf&eacute;"), "caf&eacute;", "unknown entities are left alone");
  });

  test("decodes numeric entities, decimal and hex", () => {
    assert.equal(stripHtml("&#72;&#105;"), "Hi");
    assert.equal(stripHtml("&#x48;&#x69;"), "Hi");
  });

  test("survives malformed numeric entities without throwing", () => {
    assert.equal(stripHtml("&#999999999999;"), "");
    assert.equal(stripHtml("&#x110000;"), "");
  });

  test("collapses whitespace", () => {
    assert.equal(stripHtml("a\n\n   b\t\tc"), "a b c");
  });

  test("handles empty input", () => {
    assert.equal(stripHtml(""), "");
  });
});

describe("trimTo", () => {
  test("leaves short text alone", () => {
    assert.equal(trimTo("short", 100), "short");
  });

  test("does not cut mid-word when a space is available late enough", () => {
    const out = trimTo("alpha beta gamma delta", 14);
    assert.ok(out.endsWith("…"));
    assert.ok(!out.includes("gam…"), `cut mid-word: ${out}`);
  });

  test("hard-cuts when there is no late space", () => {
    const out = trimTo("aaaaaaaaaaaaaaaaaaaaaaaaa", 10);
    assert.equal(out.length, 11); // 10 + ellipsis
  });

  test("boundary: exactly at the limit is untouched", () => {
    assert.equal(trimTo("12345", 5), "12345");
  });
});

const opts = (over = {}) => ({
  summaryChars: 400,
  fullText: false,
  feedFolders: new Map([["feed/x", ["AI", "AI - Research"]]]),
  visibleLabels: new Set(["AI", "AI - Research"]),
  ...over,
});

describe("normalizeArticle", () => {
  const entry = {
    id: "e1",
    title: "A <b>bold</b> title",
    published: 1755800000000,
    engagement: 214,
    canonicalUrl: "https://example.com/a",
    origin: { streamId: "feed/x", title: "r/LocalLLaMA", htmlUrl: "https://reddit.com" },
    summary: { content: "<p>Body text here.</p>" },
    content: { content: "<p>The entire article, thousands of words.</p>" },
  };

  test("produces exactly the documented fields", () => {
    const a = normalizeArticle(entry, opts());
    assert.deepEqual(Object.keys(a).sort(), [
      "engagement",
      "folders",
      "id",
      "published",
      "source",
      "summary",
      "title",
      "url",
    ]);
  });

  test("never leaks the heavy raw fields", () => {
    const a = normalizeArticle(entry, opts());
    for (const k of ["content", "visual", "enclosure", "origin", "alternate"]) {
      assert.ok(!(k in a), `${k} leaked into the normalized article`);
    }
  });

  test("strips HTML from the title", () => {
    assert.equal(normalizeArticle(entry, opts()).title, "A bold title");
  });

  test("prefers summary over full content", () => {
    assert.equal(normalizeArticle(entry, opts()).summary, "Body text here.");
  });

  test("falls back to content when summary is absent", () => {
    const { summary, ...rest } = entry;
    assert.equal(
      normalizeArticle(rest, opts()).summary,
      "The entire article, thousands of words.",
    );
  });

  test("trims to summaryChars", () => {
    const long = { ...entry, summary: { content: "x".repeat(1000) } };
    const a = normalizeArticle(long, opts({ summaryChars: 50 }));
    assert.ok(a.summary.length <= 51, `got ${a.summary.length}`);
  });

  test("summary_full appears only when fullText is on and there is more to show", () => {
    const long = { ...entry, summary: { content: "y".repeat(1000) } };
    assert.ok(!("summary_full" in normalizeArticle(long, opts())));
    const withFull = normalizeArticle(long, opts({ fullText: true, summaryChars: 50 }));
    assert.equal(withFull.summary_full.length, 1000);
  });

  test("summary_full is omitted when the text already fits", () => {
    const a = normalizeArticle(entry, opts({ fullText: true }));
    assert.ok(!("summary_full" in a));
  });

  test("url falls back canonical -> alternate -> origin", () => {
    assert.equal(normalizeArticle(entry, opts()).url, "https://example.com/a");

    const alt = { ...entry, canonicalUrl: undefined, alternate: [{ href: "https://alt.example" }] };
    assert.equal(normalizeArticle(alt, opts()).url, "https://alt.example");

    const org = { ...entry, canonicalUrl: undefined, alternate: [] };
    assert.equal(normalizeArticle(org, opts()).url, "https://reddit.com");

    const none = { ...entry, canonicalUrl: undefined, alternate: [], origin: { streamId: "feed/x" } };
    assert.equal(normalizeArticle(none, opts()).url, null);
  });

  test("attributes folders from the subscription map", () => {
    assert.deepEqual(normalizeArticle(entry, opts()).folders, ["AI", "AI - Research"]);
  });

  test("hides folders outside scope", () => {
    const a = normalizeArticle(entry, opts({ visibleLabels: new Set(["AI"]) }));
    assert.deepEqual(a.folders, ["AI"]);
  });

  test("survives an entry with almost nothing set", () => {
    const a = normalizeArticle({ id: "bare" }, opts());
    assert.equal(a.title, "(untitled)");
    assert.equal(a.source, "(unknown source)");
    assert.equal(a.url, null);
    assert.equal(a.published, 0);
    assert.equal(a.engagement, 0);
    assert.deepEqual(a.folders, []);
    assert.equal(a.summary, "");
  });

  test("falls back to crawled when published is missing", () => {
    const a = normalizeArticle({ id: "c", crawled: 123 }, opts());
    assert.equal(a.published, 123);
  });

  test("engagement of 0 is preserved, not treated as missing", () => {
    const a = normalizeArticle({ id: "z", engagement: 0 }, opts());
    assert.equal(a.engagement, 0);
  });
});

describe("dedupe", () => {
  test("keeps one entry per id and merges folder membership", () => {
    const out = dedupe([
      { id: "a", folders: ["AI"], title: "t" },
      { id: "a", folders: ["AI - Research"], title: "t" },
      { id: "b", folders: [], title: "u" },
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].folders, ["AI", "AI - Research"]);
  });

  test("does not duplicate a folder already present", () => {
    const out = dedupe([
      { id: "a", folders: ["AI"] },
      { id: "a", folders: ["AI"] },
    ]);
    assert.deepEqual(out[0].folders, ["AI"]);
  });

  test("preserves input order of first appearance", () => {
    const out = dedupe([
      { id: "b", folders: [] },
      { id: "a", folders: [] },
      { id: "b", folders: [] },
    ]);
    assert.deepEqual(out.map((a) => a.id), ["b", "a"]);
  });

  test("empty input", () => {
    assert.deepEqual(dedupe([]), []);
  });
});
