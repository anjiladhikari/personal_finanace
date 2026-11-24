import { QUICK_CATEGORY_LIMIT } from '@/domain/categories';

/** Chip geometry, matching the chip styles in ExpenseForm (dp). */
export const CHIP_METRICS = {
  paddingHorizontal: 12,
  icon: 18,
  iconGap: 8,
  border: 2,
  /** Space between chips, horizontally and vertically. */
  gap: 8,
  fontSize: 14,
} as const;

export const SEE_MORE_LABEL = 'See more';
export const QUICK_CHIP_ROWS = 2;

/**
 * Cautious width estimate for a chip, used until the real width has been
 * measured on screen. Average character width is taken a little wider than
 * the native font's, so an estimate never lets chips spill into a third row.
 */
export function estimateChipWidth(label: string, fontScale: number): number {
  const { paddingHorizontal, icon, iconGap, border, fontSize } = CHIP_METRICS;
  return paddingHorizontal * 2 + icon + iconGap + border + [...label].length * fontSize * Math.max(fontScale, 1) * 0.56;
}

/** Rows needed to lay out these widths left to right with wrapping (a chip wider than a row takes the row). */
export function rowsNeeded(widths: readonly number[], available: number): number {
  let rows = 0;
  let used = 0;
  for (const raw of widths) {
    const width = Math.min(raw, available);
    if (rows === 0 || used + CHIP_METRICS.gap + width > available) {
      rows += 1;
      used = width;
    } else {
      used += CHIP_METRICS.gap + width;
    }
  }
  return rows;
}

/**
 * The quick-access chips to show: as many of `quick` as fit in two rows
 * together with the "See more" control (at most six, at least one). A
 * category chosen from "See more" that is not among them replaces the last
 * chip shown, never adding a row; fewer chips are shown if it is wider.
 */
export function visibleQuickChips(
  quick: readonly string[],
  selected: string | null,
  available: number,
  widthOf: (label: string) => number,
): string[] {
  const fits = (labels: readonly string[]) =>
    rowsNeeded([...labels.map(widthOf), widthOf(SEE_MORE_LABEL)], available) <= QUICK_CHIP_ROWS;

  let shown = quick.slice(0, QUICK_CATEGORY_LIMIT);
  while (shown.length > 1 && !fits(shown)) shown = shown.slice(0, -1);
  if (selected === null || shown.includes(selected)) return shown;

  shown = [...shown.slice(0, -1), selected];
  while (shown.length > 1 && !fits(shown)) shown = [...shown.slice(0, -2), selected];
  return shown;
}
