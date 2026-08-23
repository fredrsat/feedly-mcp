/**
 * Feedly HTTP client (spec §5).
 *
 * Owns three things the rest of the code should not have to think about:
 * budget accounting, the disk cache, and turning HTTP failures into the named
 * errors from spec §6. Nothing above this layer sees a status code.
 */

import { Budget } from "./budget.js";
import { Cache } from "./cache.js";
import { errors, FeedlyMcpError, redact } from "./errors.js";

export interface Profile {
  id: string;
  email?: string;
  fullName?: string;
  product?: string;
  [key: string]: unknown;
}

export interface Category {
  id: string;
  label: string;
}

export interface Subscription {
  id: string;
  title?: string;
  website?: string;
  categories?: Category[];
}

export interface Entry {
  id: string;
  title?: string;
  published?: number;
  crawled?: number;
  engagement?: number;
  unread?: boolean;
  canonicalUrl?: string;
  alternate?: Array<{ href?: string; type?: string }>;
  origin?: { streamId?: string; title?: string; htmlUrl?: string };
  summary?: { content?: string };
  content?: { content?: string };
}

export interface StreamContents {
  id: string;
  items?: Entry[];
  continuation?: string;
}

export interface UnreadCounts {
  unreadcounts?: Array<{ id: string; count: number; updated?: number }>;
}

export interface FeedSearchResult {
  feedId: string;
  title?: string;
  website?: string;
  subscribers?: number;
  description?: string;
}

export interface FetchInfo {
  /** When the data was actually retrieved from Feedly. */
  fetchedAt: number;
  fromCache: boolean;
}

export interface Fetched<T> extends FetchInfo {
  value: T;
}

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** When set, responses are cached under this key for `ttlMs`. */
  cacheKey?: string;
  ttlMs?: number;
}

export class FeedlyClient {
  constructor(
    private readonly token: string,
    private readonly apiBase: string,
    private readonly cache: Cache,
    private readonly budget: Budget,
  ) {}

  private async request<T>(path: string, opts: RequestOptions = {}): Promise<Fetched<T>> {
    const { method = "GET", query, body, cacheKey, ttlMs } = opts;

    if (cacheKey && ttlMs) {
      const hit = this.cache.get<T>(cacheKey, ttlMs);
      if (hit) return { value: hit.value, fetchedAt: hit.storedAt, fromCache: true };
    }

    this.budget.assertCanSpend();

    const url = new URL(path, this.apiBase);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw errors.network(redact(cause, this.token));
    }

    this.budget.record(response.headers);

    if (response.status === 401) throw errors.tokenExpired();

    if (response.status === 429) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const limit = Number(response.headers.get("x-ratelimit-limit"));
      throw errors.rateLimited(
        Number.isFinite(reset) ? reset : undefined,
        Number.isFinite(limit) ? limit : undefined,
      );
    }

    const text = await response.text();

    if (!response.ok) {
      throw errors.feedly(response.status, redact(text, this.token));
    }

    let parsed: T;
    try {
      parsed = (text === "" ? {} : JSON.parse(text)) as T;
    } catch {
      throw errors.feedly(response.status, "response was not valid JSON");
    }

    const fetchedAt = Date.now();
    if (cacheKey && ttlMs) this.cache.set(cacheKey, parsed);
    return { value: parsed, fetchedAt, fromCache: false };
  }

  /** Verify the token and learn the account ID (spec §5: never hardcode it). */
  profile(ttlMs: number): Promise<Fetched<Profile>> {
    return this.request<Profile>("/v3/profile", { cacheKey: "profile", ttlMs });
  }

  categories(ttlMs: number): Promise<Fetched<Category[]>> {
    return this.request<Category[]>("/v3/categories", { cacheKey: "categories", ttlMs });
  }

  subscriptions(ttlMs: number): Promise<Fetched<Subscription[]>> {
    return this.request<Subscription[]>("/v3/subscriptions", { cacheKey: "subscriptions", ttlMs });
  }

  unreadCounts(ttlMs: number): Promise<Fetched<UnreadCounts>> {
    return this.request<UnreadCounts>("/v3/markers/counts", {
      cacheKey: "markers-counts",
      ttlMs,
    });
  }

  streamContents(
    params: {
      streamId: string;
      count: number;
      newerThan?: number;
      unreadOnly?: boolean;
      ranked?: "newest" | "oldest";
      continuation?: string;
    },
    ttlMs: number,
  ): Promise<Fetched<StreamContents>> {
    const query = {
      streamId: params.streamId,
      count: params.count,
      newerThan: params.newerThan,
      unreadOnly: params.unreadOnly,
      ranked: params.ranked ?? "newest",
      continuation: params.continuation,
    };
    return this.request<StreamContents>("/v3/streams/contents", {
      query,
      cacheKey: `stream:${JSON.stringify(query)}`,
      ttlMs,
    });
  }

  searchFeeds(query: string, count: number): Promise<Fetched<{ results?: FeedSearchResult[] }>> {
    return this.request<{ results?: FeedSearchResult[] }>("/v3/search/feeds", {
      query: { query, count },
      cacheKey: `search:${query}:${count}`,
      ttlMs: 60 * 60_000,
    });
  }

  markRead(body: Record<string, unknown>): Promise<Fetched<unknown>> {
    return this.request<unknown>("/v3/markers", { method: "POST", body });
  }

  /** Invalidate everything that a write could have made stale (spec §8). */
  invalidateAfterWrite(): void {
    this.cache.delete("markers-counts");
  }
}

export { FeedlyMcpError };
