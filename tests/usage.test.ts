import { describe, expect, it } from "bun:test";
import { tokenTotal } from "../src/core/usage.js";

describe("tokenTotal", () => {
  it("counts every disjoint OpenCode token category", () => {
    expect(
      tokenTotal({
        input: 10,
        output: 20,
        reasoning: 5,
        cacheRead: 100,
        cacheWrite: 2,
      })
    ).toBe(137);
  });

  it("uses a larger provider total when category metadata is partial", () => {
    expect(tokenTotal({ total: 200, input: 10, output: 20 })).toBe(200);
  });

  it("ignores invalid and negative provider values", () => {
    expect(tokenTotal({ total: Number.NaN, input: -1, output: 3 })).toBe(3);
  });
});
