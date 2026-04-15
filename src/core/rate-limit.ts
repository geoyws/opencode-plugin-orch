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

// Registry of per-team RateLimiter instances. Each team gets its own
// limiter so per-team config (from TeamConfig.rateLimit) applies
// independently. Teams without explicit config use the default.
export class RateLimiterRegistry {
  private limiters = new Map<string, RateLimiter>();

  constructor(public readonly defaultConfig: RateLimiterConfig) {}

  /**
   * Returns the cached RateLimiter for this team, or creates one with the
   * provided config if absent.
   *
   * Note: config is captured at first-touch. Subsequent calls with a
   * different config for the same teamID silently return the cached
   * limiter. To change a team's rate limit config at runtime, call
   * `remove(teamID)` first, then `forTeam(teamID, newConfig)`.
   */
  forTeam(teamID: string, config?: RateLimiterConfig): RateLimiter {
    const existing = this.limiters.get(teamID);
    if (existing) return existing;
    const limiter = new RateLimiter(config ?? this.defaultConfig);
    this.limiters.set(teamID, limiter);
    return limiter;
  }

  remove(teamID: string): void {
    this.limiters.delete(teamID);
  }
}
