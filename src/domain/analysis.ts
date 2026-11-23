/** Category breakdown for a period. All amounts are integer minor units. */

export interface CategoryShare {
  readonly category: string;
  readonly amountMinor: number;
  /** Share of the period total in hundredths of a percent; shares sum to exactly 10000. */
  readonly percentBasisPoints: number;
  /** The same share as a percentage with two decimals (e.g. 33.34). */
  readonly percentage: number;
}

export interface CategoryBreakdown {
  readonly totalMinor: number;
  readonly categories: readonly CategoryShare[];
}

/** Code-point order, so ties sort identically on every device and locale. */
function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Splits `scale` units in proportion to `amounts` (which sum to `total`) with
 * the largest-remainder method: every share is floored, then the spare units
 * go to the largest remainders (ties to the earlier index). The result always
 * sums to `scale` and uses integer arithmetic only.
 */
function largestRemainder(amounts: readonly number[], total: number, scale: number): number[] {
  const exact = amounts.map((amount) => amount * scale);
  const shares = exact.map((value) => Math.floor(value / total));
  let remaining = scale - shares.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value % total }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of byRemainder) {
    if (remaining === 0) break;
    shares[index] = (shares[index] ?? 0) + 1;
    remaining -= 1;
  }
  return shares;
}

/**
 * Sorts categories by descending amount (ties by name) and assigns
 * percentages with the largest-remainder method so they add up to 100.
 */
export function breakdownByCategory(
  totals: readonly { readonly category: string; readonly amountMinor: number }[],
): CategoryBreakdown {
  const rows = totals
    .filter((row) => row.amountMinor > 0)
    .map((row) => ({ category: row.category, amountMinor: row.amountMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor || compareNames(a.category, b.category));
  const totalMinor = rows.reduce((sum, row) => sum + row.amountMinor, 0);
  if (totalMinor === 0) return { totalMinor: 0, categories: [] };

  const floors = largestRemainder(
    rows.map((row) => row.amountMinor),
    totalMinor,
    10_000,
  );
  return {
    totalMinor,
    categories: rows.map((row, index) => {
      const percentBasisPoints = floors[index] ?? 0;
      return { ...row, percentBasisPoints, percentage: percentBasisPoints / 100 };
    }),
  };
}

/**
 * Display percentages in tenths of a percent (875 means 87.5 %), in the same
 * order as `amounts`. They add up to exactly 1000 (largest remainder), so a
 * share can round to 0 even when its amount is positive; show that as
 * "<0.1%". Money is never rounded.
 */
export function percentTenths(amounts: readonly number[]): number[] {
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  if (total <= 0) return amounts.map(() => 0);
  return largestRemainder(amounts, total, 1_000);
}
