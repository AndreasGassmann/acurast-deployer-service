/**
 * Minimal in-memory fixed-window rate limiter keyed by an arbitrary string
 * (e.g. client IP). No external store — single-process only.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the key is allowed (and records the hit), false if over limit. */
  check(key: string, nowMs: number): boolean {
    if (this.max <= 0) return true;
    const entry = this.hits.get(key);
    if (!entry || nowMs - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: nowMs });
      return true;
    }
    if (entry.count >= this.max) return false;
    entry.count += 1;
    return true;
  }
}
