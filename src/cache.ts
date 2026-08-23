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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Entry<T> {
  storedAt: number;
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
    const entry: Entry<T> = { storedAt: Date.now(), value };
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
