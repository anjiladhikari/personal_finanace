import { useMemo } from 'react';
import { useColorScheme } from 'react-native';

/**
 * Design tokens. Light colours follow the brand values; dark ones are the
 * coordinated equivalents. Contrast (WCAG): body text ≥ 13:1, secondary text
 * ≥ 5:1, accent text ≥ 7:1, input outlines ≥ 3:1 in both schemes.
 */
export type Scheme = 'light' | 'dark';

export interface Palette {
  readonly background: string;
  readonly surface: string;
  /** Tracks of segmented controls and quiet fills. */
  readonly surfaceMuted: string;
  readonly text: string;
  readonly textMuted: string;
  /** Hairline dividers and card edges (decorative). */
  readonly border: string;
  /** Boundaries of inputs and controls (≥ 3:1 against the surface). */
  readonly outline: string;
  readonly accent: string;
  readonly onAccent: string;
  /** Selected-but-quiet fills, e.g. a chosen category. */
  readonly accentSoft: string;
  readonly danger: string;
  readonly dangerSoft: string;
  readonly warningSoft: string;
  /** Snackbar-style confirmation. */
  readonly inverseSurface: string;
  readonly onInverse: string;
  /** Lines and tick marks in charts. */
  readonly chartAxis: string;
}

const light: Palette = {
  background: '#F5F7F5',
  surface: '#FFFFFF',
  surfaceMuted: '#ECF0ED',
  text: '#182C24',
  textMuted: '#586B61',
  border: '#DCE3DE',
  outline: '#78897F',
  accent: '#145D43',
  onAccent: '#FFFFFF',
  accentSoft: '#E3F0EA',
  danger: '#B3261E',
  dangerSoft: '#FCEDEC',
  warningSoft: '#FFF4DC',
  inverseSurface: '#182C24',
  onInverse: '#FFFFFF',
  chartAxis: '#586B61',
};

const dark: Palette = {
  background: '#0E1512',
  surface: '#17201C',
  surfaceMuted: '#212C27',
  text: '#E4EEE8',
  textMuted: '#A2B4AA',
  border: '#2C3A33',
  outline: '#5E7066',
  accent: '#6FCF9F',
  onAccent: '#0B2117',
  accentSoft: '#1D3A2E',
  danger: '#F2B8B5',
  dangerSoft: '#3A1F1E',
  warningSoft: '#332A12',
  inverseSurface: '#E4EEE8',
  onInverse: '#182C24',
  chartAxis: '#A2B4AA',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

/** Native font (Roboto on Android); hierarchy comes from size and weight. */
export const typography = {
  display: { fontSize: 40, lineHeight: 48, fontWeight: '700' },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400' },
  bodyStrong: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '500' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
} as const;

/** Minimum touch target (Android guidance: 48 dp). */
export const TOUCH_TARGET = 48;

export interface Theme {
  readonly scheme: Scheme;
  readonly colors: Palette;
}

export const themes: Readonly<Record<Scheme, Theme>> = {
  light: { scheme: 'light', colors: light },
  dark: { scheme: 'dark', colors: dark },
};

/** The theme for the system appearance (app.json userInterfaceStyle: automatic). */
export function useTheme(): Theme {
  return themes[useColorScheme() === 'dark' ? 'dark' : 'light'];
}

/**
 * Styles that depend on the theme. Pass a module-level factory so the
 * StyleSheet is built once per scheme.
 */
export function useThemedStyles<T>(factory: (theme: Theme) => T): T {
  const theme = useTheme();
  return useMemo(() => factory(theme), [factory, theme]);
}
