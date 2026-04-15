// Unit tests for the sliding-window RateLimiter.

import { describe, test, expect } from "bun:test";
import { RateLimiter } from "../src/core/rate-limit.js";

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
