import { BUILT_IN_REGISTRY, colourForName, type CategoryColour, type CategoryRegistry } from '@/domain/categories';

import type { Scheme } from './theme';

/**
 * Hex steps for each category colour. Each category keeps its colour in every
 * period and in both chart types. Eight hues cannot all be told apart
 * pairwise under colour-vision deficiency, so colour is never the only cue:
 * every bar and pie slice also carries its category name.
 */
const HEX: Readonly<Record<Scheme, Readonly<Record<CategoryColour, string>>>> = {
  light: {
    blue: '#2A78D6',
    orange: '#EB6834',
    aqua: '#1BAF7A',
    yellow: '#EDA100',
    magenta: '#E87BA4',
    green: '#008300',
    violet: '#6250D6',
    red: '#E34948',
  },
  // The same hues stepped for the dark card colour; all ≥ 3:1 against it.
  dark: {
    blue: '#3987E5',
    orange: '#D95926',
    aqua: '#199E70',
    yellow: '#C98500',
    magenta: '#D55181',
    green: '#0CA30C',
    violet: '#9085E9',
    red: '#E66767',
  },
};

/** Neutral grey for the aggregated pie slice (3.5:1 on white, 5.4:1 on the dark card). */
const REMAINING: Readonly<Record<Scheme, string>> = { light: '#8A8984', dark: '#8F948F' };

export function remainingColor(scheme: Scheme = 'light'): string {
  return REMAINING[scheme];
}

export function colourHex(colour: CategoryColour, scheme: Scheme = 'light'): string {
  return HEX[scheme][colour];
}

/**
 * The chart colour of a category label: its definition's colour (built-in or
 * custom, stored so it never changes), or one derived from the name for a
 * label with no definition (e.g. typed directly in the sheet).
 */
export function categoryColor(category: string, scheme: Scheme = 'light', registry: CategoryRegistry = BUILT_IN_REGISTRY): string {
  const colour = registry.find(category)?.colour ?? colourForName(category);
  return HEX[scheme][colour];
}
