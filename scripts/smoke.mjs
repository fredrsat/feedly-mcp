/**
 * End-to-end smoke test against a live Feedly account.
 *
 * Starts the built server over stdio as a real MCP client would, then exercises
 * every tool. Costs a handful of API calls out of the daily 50, so it prints the
 * remaining quota as it goes.
 *
 *   npm run build && node --env-file=.env scripts/smoke.mjs
 *
 * mark_read is deliberately only exercised in its refusal path. It is
 * irreversible, so there is no safe way to test the success path.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!process.env.FEEDLY_TOKEN) {
  console.error("FEEDLY_TOKEN is not set. Try: node --env-file=.env scripts/smoke.mjs");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: "node",
  args: [join(root, "dist", "cli.js")],
  env: { ...process.env },
  stderr: "pipe",
});

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`TOOLS (${tools.length}): ${tools.map((t) => t.name).join(", ")}\n`);

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  const left = parsed?.meta?.calls_left_today;
  console.log(
    `── ${name}(${JSON.stringify(args)})${res.isError ? "  [isError]" : ""}` +
      (left !== undefined ? `   ${left} calls left today` : ""),
  );
  return parsed;
}

const probeFolder = process.env.SMOKE_FOLDER ?? undefined;

const folders = await call("list_folders");
console.log(`   ${folders.folders?.length} folders visible`);
const target = probeFolder ?? folders.folders?.[1]?.label ?? folders.folders?.[0]?.label;

const counts = await call("unread_counts");
console.log(`   total=${counts.total} account_wide=${counts.total_is_account_wide}`);

const arts = await call("get_articles", { folder: target, hours: 72, limit: 3 });
console.log(`   count=${arts.count} truncated=${arts.truncated} window=${arts.window_hours}h`);
for (const a of arts.articles ?? []) {
  console.log(`   • [${a.source}] ${a.title.slice(0, 68)}`);
  console.log(`     folders=${JSON.stringify(a.folders)} engagement=${a.engagement}`);
  console.log(`     summary(${a.summary.length} chars): ${a.summary.slice(0, 100)}…`);
  const leaked = ["content", "visual", "enclosure", "origin"].filter((k) => k in a);
  console.log(`     leaked raw fields: ${leaked.length ? leaked.join(",") : "none"}`);
}

const clamp = await call("get_articles", { folder: target, hours: 5000, limit: 1 });
console.log(`   clamped window=${clamp.window_hours}h`);

const feeds = await call("list_feeds", { folder: target });
console.log(`   ${feeds.count} feeds; first=${JSON.stringify(feeds.feeds?.[0])}`);

const search = await call("search_feeds", { query: "local llm inference", limit: 3 });
for (const r of search.results ?? []) {
  console.log(`   • ${r.title} (${r.subscribers} subs) subscribed=${r.already_subscribed}`);
}

console.log("\nRefusal paths (no API calls):");
console.log(`   mark_read →`, (await call("mark_read", { entry_ids: ["x"] })).error);
console.log(`   unknown folder →`, (await call("get_articles", { folder: "No Such Folder" })).error);
console.log(`   no target →`, (await call("mark_read", {})).error);

await client.close();
