/**
 * Call budget (spec §7).
 *
 * The verified ceiling is 50 calls/day on a developer token — not the 250/500
 * Feedly documents. That makes this the user's defence against their own agent:
 * drain it and Feedly stops working in their browser too.
 *
 * Feedly's own `X-Ratelimit-Count` is authoritative for the daily figure, so we
 * prefer it and fall back to a locally persisted counter only before the first
 * response of the day has been seen.
 */

import { Cache } from "./cache.js";
import { errors } from "./errors.js";

const STATE_KEY = "budget-state";

interface BudgetState {
  /** Last values observed from Feedly's rate-limit headers. */
  observedCount?: number;
  observedLimit?: number;
  observedResetSeconds?: number;
  observedAt?: number;
  /** Local fallback counter and the UTC day it belongs to. */
  localCount: number;
  localDay: string;
}

export interface RateLimitSnapshot {
  used: number;
  limit: number | undefined;
  remaining: number | undefined;
  resetSeconds: number | undefined;
  /** True when `used` comes from our own counter rather than Feedly's headers. */
  estimated: boolean;
}

function utcDay(at = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export class Budget {
  private sessionCount = 0;
  private lastCallAt = 0;
  private state: BudgetState;

  constructor(
    private readonly cache: Cache,
    private readonly dailyLimit: number,
    private readonly sessionLimit: number,
    private readonly warnBelow: number,
    /**
     * Idle gap after which the session counter starts over.
     *
     * A stdio server is not one conversation. Clients start the process once and
     * keep it alive for as long as the app runs — measured at 15 hours on a
     * desktop app — so every conversation shares it, and an in-memory counter
     * only resets when the app quits. Without this, "10 calls per session"
     * silently means "10 calls until you restart Claude", and a scheduled run
     * hours later inherits a spent budget it can never clear.
     */
    private readonly sessionIdleResetMs: number = 15 * 60_000,
  ) {
    const stored = cache.get<BudgetState>(STATE_KEY, Number.MAX_SAFE_INTEGER);
    const today = utcDay();
    this.state =
      stored?.value && stored.value.localDay === today
        ? stored.value
        : { localCount: 0, localDay: today };
  }

  /**
   * Claim a call slot, or throw if it cannot be afforded. Called ahead of every
   * request not already served from cache.
   *
   * This reserves rather than merely checks. Several tools fire concurrent
   * requests — the folder index alone issues three — and a check that does not
   * increment lets all of them pass while the counter still reads under the
   * limit. Measured: a ceiling of 10 reached 12, and the resulting error then
   * reported "12/10", which reads like a counter that never resets.
   */
  reserve(): void {
    const now = Date.now();
    if (this.lastCallAt !== 0 && now - this.lastCallAt >= this.sessionIdleResetMs) {
      this.sessionCount = 0;
    }
    this.lastCallAt = now;

    if (this.sessionCount >= this.sessionLimit) {
      throw errors.budgetExhausted("session", this.sessionCount, this.sessionLimit);
    }
    const used = this.snapshot().used;
    if (used >= this.dailyLimit) {
      throw errors.budgetExhausted("daily", used, this.dailyLimit, this.state.localCount);
    }
    this.sessionCount += 1;
  }

  /** Give back a slot claimed for a request that never reached Feedly. */
  release(): void {
    if (this.sessionCount > 0) this.sessionCount -= 1;
  }

  /** How many of today's calls this server is responsible for. */
  get callsByThisServerToday(): number {
    return this.state.localCount;
  }

  /**
   * Fold Feedly's own accounting into the daily figures. The session slot was
   * already claimed by `reserve()`, so this must not increment it again.
   */
  record(headers: Headers): void {
    const today = utcDay();
    if (this.state.localDay !== today) {
      this.state = { localCount: 0, localDay: today };
    }
    this.state.localCount += 1;

    const count = numeric(headers.get("x-ratelimit-count"));
    const limit = numeric(headers.get("x-ratelimit-limit"));
    const reset = numeric(headers.get("x-ratelimit-reset"));

    if (count !== undefined) {
      this.state.observedCount = count;
      this.state.observedAt = Date.now();
    }
    if (limit !== undefined) this.state.observedLimit = limit;
    if (reset !== undefined) this.state.observedResetSeconds = reset;

    this.cache.set(STATE_KEY, this.state);
  }

  snapshot(): RateLimitSnapshot {
    const s = this.state;
    const freshEnough =
      s.observedCount !== undefined &&
      s.observedAt !== undefined &&
      utcDay(new Date(s.observedAt)) === utcDay();

    const used = freshEnough ? s.observedCount! : s.localCount;
    const limit = s.observedLimit;
    return {
      used,
      limit,
      remaining: limit !== undefined ? Math.max(0, limit - used) : undefined,
      resetSeconds: s.observedResetSeconds,
      estimated: !freshEnough,
    };
  }

  get callsThisSession(): number {
    return this.sessionCount;
  }

  get sessionRemaining(): number {
    return Math.max(0, this.sessionLimit - this.sessionCount);
  }

  /**
   * Warning text for the `meta` block, or undefined when there is nothing to say.
   * Spec §7: this belongs in the tool result, not only in a log.
   */
  warning(): string | undefined {
    const snap = this.snapshot();
    const budgetLeft = Math.max(0, this.dailyLimit - snap.used);

    if (snap.remaining !== undefined && snap.remaining <= this.warnBelow) {
      return `Only ${snap.remaining} Feedly API calls left today${
        snap.limit ? ` of ${snap.limit}` : ""
      }. Draining the quota also breaks Feedly in your browser until it resets.`;
    }
    if (budgetLeft <= this.warnBelow) {
      return `Only ${budgetLeft} calls left under the daily ceiling of ${this.dailyLimit} ` +
        `(${snap.used} used today account-wide, ${this.state.localCount} through this ` +
        `server). Raise budget.daily_calls if you want more.`;
    }
    if (this.sessionRemaining <= Math.min(3, this.sessionLimit)) {
      return `Only ${this.sessionRemaining} calls left in this session's budget of ${this.sessionLimit}.`;
    }
    return undefined;
  }
}

function numeric(value: string | null): number | undefined {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
