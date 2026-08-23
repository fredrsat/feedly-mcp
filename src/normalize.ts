/**
 * Article normalisation (spec §6).
 *
 * Raw Feedly JSON is heavy — `content.content` can be an entire article, and a
 * hundred of those would consume the whole context window in one tool call. So
 * `content`, `visual`, `enclosure` and the raw `origin` object never leave this
 * module; what comes out is a small, flat record.
 */

import type { Entry } from "./feedly.js";

export interface NormalizedArticle {
  id: string;
  title: string;
  source: string;
  url: string | null;
  published: number;
  folders: string[];
  engagement: number;
  summary: string;
  summary_full?: string;
}

export interface NormalizeOptions {
  summaryChars: number;
  fullText: boolean;
  /** Feed stream ID → folder labels. Only in-scope labels should be passed in. */
  feedFolders: Map<string, string[]>;
  /** Folder labels the caller is allowed to see. */
  visibleLabels: Set<string>;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

export function stripHtml(html: string): string {
  return html
    // Drop entire script/style bodies rather than just their tags.
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    // Block-level boundaries are worth a space so words don't fuse together.
    .replace(/<\/?(p|div|br|li|tr|h[1-6]|blockquote)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/g, " ")
    .trim();
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Trim to a length without cutting mid-word. */
export function trimTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function bestUrl(entry: Entry): string | null {
  if (entry.canonicalUrl) return entry.canonicalUrl;
  const alt = entry.alternate?.find((a) => a.href);
  if (alt?.href) return alt.href;
  return entry.origin?.htmlUrl ?? null;
}

export function normalizeArticle(entry: Entry, opts: NormalizeOptions): NormalizedArticle {
  const rawBody = entry.summary?.content ?? entry.content?.content ?? "";
  const text = stripHtml(rawBody);

  const streamId = entry.origin?.streamId;
  const folders = (streamId ? (opts.feedFolders.get(streamId) ?? []) : []).filter((label) =>
    opts.visibleLabels.has(label),
  );

  const article: NormalizedArticle = {
    id: entry.id,
    title: entry.title ? stripHtml(entry.title) : "(untitled)",
    source: entry.origin?.title ?? "(unknown source)",
    url: bestUrl(entry),
    published: entry.published ?? entry.crawled ?? 0,
    folders: [...new Set(folders)],
    engagement: entry.engagement ?? 0,
    summary: trimTo(text, opts.summaryChars),
  };

  if (opts.fullText && text.length > opts.summaryChars) {
    article.summary_full = text;
  }
  return article;
}

/**
 * Deduplicate by id (spec §11). The same article legitimately appears in several
 * folders; the agent should see it once, with every folder it belongs to.
 */
export function dedupe(articles: NormalizedArticle[]): NormalizedArticle[] {
  const byId = new Map<string, NormalizedArticle>();
  for (const article of articles) {
    const existing = byId.get(article.id);
    if (!existing) {
      byId.set(article.id, article);
      continue;
    }
    existing.folders = [...new Set([...existing.folders, ...article.folders])];
  }
  return [...byId.values()];
}
