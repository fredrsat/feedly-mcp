import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  buildFolderIndex,
  isVisible,
  resolveFolder,
  unmatchedScopeEntries,
} from "../dist/folders.js";

const categories = [
  { id: "user/u1/category/AI", label: "AI" },
  { id: "user/u1/category/9f2a-uuid", label: "AI - Research" },
  { id: "user/u1/category/tech", label: "Tech" },
  { id: "user/u1/category/private-uuid", label: "Private" },
];

const subscriptions = [
  {
    id: "feed/a",
    title: "Alpha",
    categories: [categories[0], categories[1]],
  },
  { id: "feed/b", title: "Beta", categories: [categories[0]] },
  { id: "feed/c", title: "Gamma", categories: [categories[3]] },
  { id: "feed/d", title: "Orphan", categories: [] },
];

const counts = {
  unreadcounts: [
    { id: "user/u1/category/AI", count: 100 },
    { id: "user/u1/category/9f2a-uuid", count: 40 },
  ],
};

const open = { includeFolders: [], excludeFolders: [] };

describe("buildFolderIndex", () => {
  test("counts feeds per folder", () => {
    const index = buildFolderIndex(categories, subscriptions, counts, open);
    const byLabel = Object.fromEntries(index.all.map((f) => [f.label, f.feedCount]));
    assert.equal(byLabel["AI"], 2);
    assert.equal(byLabel["AI - Research"], 1);
    assert.equal(byLabel["Tech"], 0, "an empty folder is still listed");
  });

  test("attaches unread counts, defaulting to zero", () => {
    const index = buildFolderIndex(categories, subscriptions, counts, open);
    const byLabel = Object.fromEntries(index.all.map((f) => [f.label, f.unread]));
    assert.equal(byLabel["AI"], 100);
    assert.equal(byLabel["Tech"], 0);
  });

  test("maps each feed to every folder it belongs to", () => {
    const index = buildFolderIndex(categories, subscriptions, counts, open);
    assert.deepEqual(index.feedFolders.get("feed/a"), ["AI", "AI - Research"]);
    assert.deepEqual(index.feedFolders.get("feed/d"), []);
  });

  test("works when unread counts are unavailable", () => {
    const index = buildFolderIndex(categories, subscriptions, undefined, open);
    assert.ok(index.all.every((f) => f.unread === 0));
  });

  test("handles an account with no folders at all", () => {
    const index = buildFolderIndex([], [], undefined, open);
    assert.deepEqual(index.all, []);
    assert.deepEqual(index.visible, []);
  });
});

describe("scope", () => {
  const f = (label, id = "x") => ({ id, label, feedCount: 0, unread: 0 });

  test("everything is visible when no scope is set", () => {
    assert.equal(isVisible(f("Anything"), open), true);
  });

  test("include acts as an allowlist", () => {
    const scope = { includeFolders: ["AI"], excludeFolders: [] };
    assert.equal(isVisible(f("AI"), scope), true);
    assert.equal(isVisible(f("Private"), scope), false);
  });

  test("matching a label is case-insensitive", () => {
    const scope = { includeFolders: ["ai"], excludeFolders: [] };
    assert.equal(isVisible(f("AI"), scope), true);
  });

  test("matching an ID is exact — labels and IDs differ in case", () => {
    const scope = { includeFolders: ["user/u1/category/tech"], excludeFolders: [] };
    assert.equal(isVisible(f("Tech", "user/u1/category/tech"), scope), true);
    assert.equal(isVisible(f("Tech", "user/u1/category/TECH"), scope), false);
  });

  test("exclude wins over include", () => {
    const scope = { includeFolders: ["AI"], excludeFolders: ["AI"] };
    assert.equal(isVisible(f("AI"), scope), false);
  });

  test("exclude alone leaves everything else visible", () => {
    const scope = { includeFolders: [], excludeFolders: ["Private"] };
    assert.equal(isVisible(f("AI"), scope), true);
    assert.equal(isVisible(f("Private"), scope), false);
  });

  test("index.visible reflects the rules", () => {
    const scope = { includeFolders: [], excludeFolders: ["Private"] };
    const index = buildFolderIndex(categories, subscriptions, counts, scope);
    assert.deepEqual(
      index.visible.map((v) => v.label),
      ["AI", "AI - Research", "Tech"],
    );
  });
});

describe("resolveFolder", () => {
  const scope = { includeFolders: [], excludeFolders: ["Private"] };
  const index = buildFolderIndex(categories, subscriptions, counts, scope);

  test("resolves by label", () => {
    assert.equal(resolveFolder("AI - Research", index, scope).id, "user/u1/category/9f2a-uuid");
  });

  test("resolves by label ignoring case and padding", () => {
    assert.equal(resolveFolder("  ai - research  ", index, scope).label, "AI - Research");
  });

  test("resolves by raw ID", () => {
    assert.equal(resolveFolder("user/u1/category/9f2a-uuid", index, scope).label, "AI - Research");
  });

  test("an unknown folder is folder_not_found, listing what is available", () => {
    assert.throws(
      () => resolveFolder("Nope", index, scope),
      (err) => err.code === "folder_not_found" && /AI - Research/.test(err.message),
    );
  });

  test("an excluded folder is out_of_scope, not not-found", () => {
    assert.throws(
      () => resolveFolder("Private", index, scope),
      (err) => err.code === "out_of_scope",
    );
  });

  test("scope is enforced against a raw ID, not just the label", () => {
    assert.throws(
      () => resolveFolder("user/u1/category/private-uuid", index, scope),
      (err) => err.code === "out_of_scope",
      "passing an ID learned elsewhere must not bypass scope",
    );
  });

  test("the not-found message does not name out-of-scope folders", () => {
    assert.throws(
      () => resolveFolder("Nope", index, scope),
      (err) => !err.message.includes("Private"),
    );
  });
});

describe("unmatchedScopeEntries", () => {
  const index = buildFolderIndex(categories, subscriptions, counts, open);

  test("flags typos in either list", () => {
    const scope = { includeFolders: ["AI", "Typoo"], excludeFolders: ["Alsowrong"] };
    assert.deepEqual(unmatchedScopeEntries(index.all, scope), ["Typoo", "Alsowrong"]);
  });

  test("says nothing when every entry matches", () => {
    const scope = { includeFolders: ["ai"], excludeFolders: ["Private"] };
    assert.deepEqual(unmatchedScopeEntries(index.all, scope), []);
  });
});
