// Unit tests for the sliding-window RateLimiter + RateLimiterRegistry.

import { describe, test, expect } from "bun:test";
import { RateLimiter, RateLimiterRegistry } from "../src/core/rate-limit.js";
import { parseRateLimitEnv } from "../src/plugin.js";

describe("RateLimiter", () => {
  test("tryAcquire allows first N calls and blocks the N+1st", () => {
    const rl = new RateLimiter({ windowMs: 60_000, maxCalls: 3 });
    expect(rl.tryAcquire("alice")).toBe(true);
    expect(rl.tryAcquire("alice")).toBe(true);
    expect(rl.tryAcquire("alice")).toBe(true);
    expect(rl.tryAcquire("alice")).toBe(false);
  });

  test("tryAcquire resets after the window elapses", async () => {
    const rl = new RateLimiter({ windowMs: 50, maxCalls: 2 });
    expect(rl.tryAcquire("k")).toBe(true);
    expect(rl.tryAcquire("k")).toBe(true);
    expect(rl.tryAcquire("k")).toBe(false);
    await new Promise((r) => setTimeout(r, 70));
    expect(rl.tryAcquire("k")).toBe(true);
  });

  test("retryAfter returns 0 when not limited and >0 when limited", () => {
    const rl = new RateLimiter({ windowMs: 60_000, maxCalls: 2 });
    expect(rl.retryAfter("k")).toBe(0);
    rl.tryAcquire("k");
    expect(rl.retryAfter("k")).toBe(0);
    rl.tryAcquire("k");
    const wait = rl.retryAfter("k");
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60_000);
  });

  test("different keys have independent buckets", () => {
    const rl = new RateLimiter({ windowMs: 60_000, maxCalls: 2 });
    expect(rl.tryAcquire("a")).toBe(true);
    expect(rl.tryAcquire("a")).toBe(true);
    expect(rl.tryAcquire("a")).toBe(false);
    // b is untouched
    expect(rl.tryAcquire("b")).toBe(true);
    expect(rl.tryAcquire("b")).toBe(true);
    expect(rl.tryAcquire("b")).toBe(false);
  });

  test("reset(key) clears only the named bucket", () => {
    const rl = new RateLimiter({ windowMs: 60_000, maxCalls: 1 });
    rl.tryAcquire("a");
    rl.tryAcquire("b");
    expect(rl.tryAcquire("a")).toBe(false);
    rl.reset("a");
    expect(rl.tryAcquire("a")).toBe(true);
    expect(rl.tryAcquire("b")).toBe(false);
  });
});

describe("RateLimiterRegistry", () => {
  test("forTeam(id, undefined) uses the default config", () => {
    const reg = new RateLimiterRegistry({ windowMs: 60_000, maxCalls: 2 });
    const lim = reg.forTeam("t1");
    expect(lim.tryAcquire("m")).toBe(true);
    expect(lim.tryAcquire("m")).toBe(true);
    expect(lim.tryAcquire("m")).toBe(false);
  });

  test("forTeam(id, config) uses the supplied config", () => {
    const reg = new RateLimiterRegistry({ windowMs: 60_000, maxCalls: 100 });
    const lim = reg.forTeam("t1", { windowMs: 60_000, maxCalls: 2 });
    expect(lim.tryAcquire("m")).toBe(true);
    expect(lim.tryAcquire("m")).toBe(true);
    expect(lim.tryAcquire("m")).toBe(false);
  });

  test("forTeam returns the SAME limiter instance on repeat calls", () => {
    const reg = new RateLimiterRegistry({ windowMs: 60_000, maxCalls: 60 });
    const a = reg.forTeam("t1");
    const b = reg.forTeam("t1");
    expect(a).toBe(b);
  });

  test("different team IDs get DIFFERENT limiter instances", () => {
    const reg = new RateLimiterRegistry({ windowMs: 60_000, maxCalls: 60 });
    const a = reg.forTeam("t1");
    const b = reg.forTeam("t2");
    expect(a).not.toBe(b);
  });

  test("remove() clears the cached limiter so new config takes effect", () => {
    const reg = new RateLimiterRegistry({ windowMs: 60_000, maxCalls: 60 });
    const a = reg.forTeam("t1", { windowMs: 60_000, maxCalls: 2 });
    // Use up the budget
    a.tryAcquire("m");
    a.tryAcquire("m");
    expect(a.tryAcquire("m")).toBe(false);
    // Remove + re-register with a different config — new instance, fresh bucket
    reg.remove("t1");
    const b = reg.forTeam("t1", { windowMs: 60_000, maxCalls: 5 });
    expect(b).not.toBe(a);
    expect(b.tryAcquire("m")).toBe(true);
  });

  test("parseRateLimitEnv reads ORCH_RATE_LIMIT_* env vars", () => {
    expect(parseRateLimitEnv({})).toEqual({ windowMs: 60_000, maxCalls: 60 });
    expect(
      parseRateLimitEnv({
        ORCH_RATE_LIMIT_WINDOW_MS: "30000",
        ORCH_RATE_LIMIT_MAX_CALLS: "5",
      })
    ).toEqual({ windowMs: 30_000, maxCalls: 5 });
    // Bad values fall back to defaults
    expect(
      parseRateLimitEnv({
        ORCH_RATE_LIMIT_WINDOW_MS: "not-a-number",
        ORCH_RATE_LIMIT_MAX_CALLS: "-5",
      })
    ).toEqual({ windowMs: 60_000, maxCalls: 60 });
  });
});
