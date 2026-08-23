/**
 * Disk cache (spec §7).
 *
 * This is quota hygiene, not an archive. Everything expires on a timer and
 * nothing is queryable — see the boundary in spec §1. It lives on disk rather
 * than in memory because the stdio process dies between conversations; without
 * that, folder and subscription lists would be refetched every single time.
 *
 * Entries are namespaced by a hash of the token, so swapping accounts can never
 * serve you the previous account's data (spec §11). The token itself is never
 * written anywhere.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Entry<T> {
  storedAt: number;
  /** The logical key, kept so entries can be invalidated by pattern. */
  key: string;
  value: T;
}

export interface CacheHit<T> {
  value: T;
  storedAt: number;
}

export class Cache {
  private readonly dir: string;

  constructor(baseDir: string, token: string) {
    const namespace = createHash("sha256").update(token).digest("hex").slice(0, 16);
    this.dir = join(baseDir, namespace);
  }

  private pathFor(key: string): string {
    const safe = createHash("sha256").update(key).digest("hex").slice(0, 32);
    return join(this.dir, `${safe}.json`);
  }

  get<T>(key: string, ttlMs: number): CacheHit<T> | undefined {
    if (ttlMs <= 0) return undefined;
    try {
      const raw = readFileSync(this.pathFor(key), "utf8");
      const entry = JSON.parse(raw) as Entry<T>;
      if (Date.now() - entry.storedAt > ttlMs) return undefined;
      return { value: entry.value, storedAt: entry.storedAt };
    } catch {
      return undefined;
    }
  }

  set<T>(key: string, value: T): void {
    const entry: Entry<T> = { storedAt: Date.now(), key, value };
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.pathFor(key), JSON.stringify(entry), { mode: 0o600 });
    } catch {
      // A cache that cannot be written is a performance problem, not a failure.
    }
  }

  delete(key: string): void {
    try {
      rmSync(this.pathFor(key), { force: true });
    } catch {
      /* ignore */
    }
  }

  /**
   * Drop every entry whose logical key matches. Keys are hashed into filenames,
   * so this reads each entry back rather than matching on the path.
   *
   * Used after a write: marking articles read invalidates the unread counts and
   * every cached article query, not just the counts (spec §8).
   */
  deleteMatching(predicate: (key: string) => boolean): number {
    let removed = 0;
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      return 0;
    }
    for (const file of files) {
      const full = join(this.dir, file);
      try {
        const entry = JSON.parse(readFileSync(full, "utf8")) as Entry<unknown>;
        if (typeof entry.key === "string" && predicate(entry.key)) {
          rmSync(full, { force: true });
          removed += 1;
        }
      } catch {
        // Unreadable or pre-`key` entry: drop it, it cannot be reasoned about.
        rmSync(full, { force: true });
      }
    }
    return removed;
  }

  /**
   * Remove entries older than the longest TTL in use, so the directory does not
   * grow without bound. Every distinct query writes a file; nothing else evicts.
   */
  prune(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    return this.deleteMatchingEntry((entry) => entry.storedAt < cutoff);
  }

  private deleteMatchingEntry(predicate: (entry: Entry<unknown>) => boolean): number {
    let removed = 0;
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      return 0;
    }
    for (const file of files) {
      const full = join(this.dir, file);
      try {
        const entry = JSON.parse(readFileSync(full, "utf8")) as Entry<unknown>;
        if (predicate(entry)) {
          rmSync(full, { force: true });
          removed += 1;
        }
      } catch {
        rmSync(full, { force: true });
        removed += 1;
      }
    }
    return removed;
  }

  /** Drop everything for this token. Used by `doctor --refresh`. */
  clear(): void {
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  get location(): string {
    return this.dir;
  }
}
