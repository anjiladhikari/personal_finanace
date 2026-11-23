import { useWindowDimensions } from 'react-native';

import { spacing } from './theme';

/** Below this many dp of width per unit of font scale, text stacks instead of sitting side by side. */
const COMPACT_BELOW = 360;
const PIE_RADIUS_MIN = 48;
const PIE_RADIUS_MAX = 120;

export interface SpendingLayout {
  /** Narrow screen or large system text: names and amounts on separate lines, period buttons in a 2 × 2 grid. */
  readonly compact: boolean;
  readonly pieRadius: number;
}

/**
 * Layout for My spending from the window width and the Android font scale.
 * The pie sits in a padded card inside the padded screen, so it fits the
 * width that is left; text never has a fixed size or line count.
 */
export function spendingLayout(width: number, fontScale: number): SpendingLayout {
  const scale = fontScale > 0 ? fontScale : 1;
  const available = Math.max(0, width - 4 * spacing.md);
  return {
    compact: width / scale < COMPACT_BELOW,
    pieRadius: Math.max(PIE_RADIUS_MIN, Math.min(PIE_RADIUS_MAX, Math.floor(available / 2))),
  };
}

export function useSpendingLayout(): SpendingLayout {
  const { width, fontScale } = useWindowDimensions();
  return spendingLayout(width, fontScale);
}
