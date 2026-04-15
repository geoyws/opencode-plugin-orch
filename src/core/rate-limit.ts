// Sliding-window rate limiter for tool calls.
//
// Keyed by arbitrary string (we use member id). Per-key bucket holds the
// timestamps of calls within the current window; `tryAcquire` prunes
// expired entries before checking the count. No background sweep —
// buckets are lazily cleaned on access.

export interface RateLimiterConfig {
  windowMs: number;
  maxCalls: number;
}

export class RateLimiter {
  private buckets = new Map<string, number[]>();

  constructor(private config: RateLimiterConfig) {}

  /** Returns true if the call is allowed, false if rate-limited. */
  tryAcquire(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    const timestamps = (this.buckets.get(key) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= this.config.maxCalls) {
      // Persist the pruned list so retryAfter sees up-to-date state.
      this.buckets.set(key, timestamps);
      return false;
    }

    timestamps.push(now);
    this.buckets.set(key, timestamps);
    return true;
  }

  /** Milliseconds until the oldest in-window call expires (0 if unblocked). */
  retryAfter(key: string): number {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    const timestamps = (this.buckets.get(key) ?? []).filter((t) => t > cutoff);
    if (timestamps.length < this.config.maxCalls) return 0;
    // Timestamps are push-only in chronological order, so [0] is always oldest.
    const oldest = timestamps[0];
    return Math.max(0, oldest + this.config.windowMs - now);
  }

  reset(key?: string): void {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }
}
