/** Provider-reported token categories after OpenCode normalization. */
export interface TokenUsageLike {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

function nonnegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * Return the complete observed token count.
 *
 * OpenCode normalizes `input` so it excludes cache reads and cache writes,
 * and normalizes `output` so it excludes reasoning. The five categories are
 * therefore disjoint and must all be included. Taking the larger of the
 * category sum and a provider total avoids silently trusting partial metadata.
 */
export function tokenTotal(usage: TokenUsageLike): number {
  const categories =
    nonnegative(usage.input) +
    nonnegative(usage.output) +
    nonnegative(usage.reasoning) +
    nonnegative(usage.cacheRead) +
    nonnegative(usage.cacheWrite);
  return Math.max(categories, nonnegative(usage.total));
}
