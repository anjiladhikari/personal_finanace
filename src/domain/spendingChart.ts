import { percentTenths, type CategoryBreakdown } from './analysis';

/** The pie shows at most this many slices; past it the tail is aggregated. */
export const PIE_MAX_SLICES = 5;

export const REMAINING_CATEGORIES_LABEL = 'Remaining categories';

export interface ChartCategory {
  readonly category: string;
  readonly amountMinor: number;
  /** Share of the total in tenths of a percent for display; all rows add up to 1000. */
  readonly percentTenths: number;
  /** Bar length on the shared scale: amount ÷ the largest category's amount. */
  readonly barFraction: number;
}

export type PieSlice =
  | { readonly kind: 'category'; readonly category: ChartCategory }
  | {
      readonly kind: 'remaining';
      readonly amountMinor: number;
      readonly percentTenths: number;
      readonly categories: readonly ChartCategory[];
    };

export interface SpendingChart {
  readonly totalMinor: number;
  /** Every category, in the analysis order (descending amount, ties by name). */
  readonly categories: readonly ChartCategory[];
  readonly slices: readonly PieSlice[];
}

/**
 * Bars, pie slices and display percentages for one analysis result. Nothing
 * here queries again or re-sorts, so every view of a period shows the same
 * numbers: the slices add up to the total and the percentages to 100.0.
 */
export function spendingChart(breakdown: CategoryBreakdown): SpendingChart {
  const source = breakdown.categories;
  const tenths = percentTenths(source.map((share) => share.amountMinor));
  const largest = source[0]?.amountMinor ?? 0;
  const categories = source.map(
    (share, index): ChartCategory => ({
      category: share.category,
      amountMinor: share.amountMinor,
      percentTenths: tenths[index] ?? 0,
      barFraction: largest > 0 ? share.amountMinor / largest : 0,
    }),
  );

  if (categories.length <= PIE_MAX_SLICES) {
    return {
      totalMinor: breakdown.totalMinor,
      categories,
      slices: categories.map((category) => ({ kind: 'category', category })),
    };
  }

  const shown = categories.slice(0, PIE_MAX_SLICES - 1);
  const rest = categories.slice(PIE_MAX_SLICES - 1);
  return {
    totalMinor: breakdown.totalMinor,
    categories,
    slices: [
      ...shown.map((category): PieSlice => ({ kind: 'category', category })),
      {
        kind: 'remaining',
        amountMinor: rest.reduce((sum, category) => sum + category.amountMinor, 0),
        // The sum of the members' display percentages, so the slice and its
        // listed members always agree.
        percentTenths: rest.reduce((sum, category) => sum + category.percentTenths, 0),
        categories: rest,
      },
    ],
  };
}
