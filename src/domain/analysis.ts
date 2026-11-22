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

  const exact = rows.map((row) => row.amountMinor * 10_000);
  const floors = exact.map((value) => Math.floor(value / totalMinor));
  let remaining = 10_000 - floors.reduce((sum, value) => sum + value, 0);
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value % totalMinor }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of byRemainder) {
    if (remaining === 0) break;
    floors[index] = (floors[index] ?? 0) + 1;
    remaining -= 1;
  }

  return {
    totalMinor,
    categories: rows.map((row, index) => {
      const percentBasisPoints = floors[index] ?? 0;
      return { ...row, percentBasisPoints, percentage: percentBasisPoints / 100 };
    }),
  };
}
