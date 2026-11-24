import { StyleSheet, Text, View } from 'react-native';
import { PieChart } from 'react-native-gifted-charts';

import { formatMoney, type CurrencyConfig } from '@/domain/money';
import type { CategoryRegistry } from '@/domain/categories';
import { REMAINING_CATEGORIES_LABEL, type ChartCategory, type PieSlice, type SpendingChart } from '@/domain/spendingChart';

import { categoryColor, remainingColor } from './categoryColors';
import { useCategoryRegistry } from './CategoryRegistry';
import { formatPercent, spokenPercent } from './spendingFormat';
import { radii, spacing, typography, useTheme, useThemedStyles, type Scheme, type Theme } from './theme';

/** Bars thinner than this would vanish for very small amounts. */
const MIN_BAR_WIDTH = 3;

interface ChartProps {
  readonly chart: SpendingChart;
  readonly currency: CurrencyConfig;
  readonly compact: boolean;
}

function figure(amountMinor: number, tenths: number, currency: CurrencyConfig): string {
  return `${formatMoney(amountMinor, currency)} · ${formatPercent(tenths, amountMinor)}`;
}

function spokenFigure(amountMinor: number, tenths: number, currency: CurrencyConfig): string {
  return `${formatMoney(amountMinor, currency)}, ${spokenPercent(tenths, amountMinor)} of total spent`;
}

function sliceAmount(slice: PieSlice): number {
  return slice.kind === 'category' ? slice.category.amountMinor : slice.amountMinor;
}

function sliceTenths(slice: PieSlice): number {
  return slice.kind === 'category' ? slice.category.percentTenths : slice.percentTenths;
}

function sliceName(slice: PieSlice): string {
  return slice.kind === 'category' ? slice.category.category : REMAINING_CATEGORIES_LABEL;
}

function sliceColor(slice: PieSlice, scheme: Scheme, registry: CategoryRegistry): string {
  return slice.kind === 'category' ? categoryColor(slice.category.category, scheme, registry) : remainingColor(scheme);
}

/** Category name and exact amount; stacked on narrow screens or with large text. */
function NameAndFigure({ name, value, compact }: { readonly name: string; readonly value: string; readonly compact: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.text, compact ? styles.textStacked : styles.textInline]}>
      <Text style={[styles.name, !compact && styles.nameInline]}>{name}</Text>
      <Text style={styles.figure}>{value}</Text>
    </View>
  );
}

/**
 * Horizontal bars on one scale from a zero baseline (the left rule). The
 * largest category spans the full width; every row prints its exact amount.
 */
export function CategoryBars({ chart, currency, compact }: ChartProps) {
  const styles = useThemedStyles(makeStyles);
  const { scheme } = useTheme();
  const registry = useCategoryRegistry();
  const largest = chart.categories[0]?.amountMinor ?? 0;
  return (
    <View testID="bar-chart">
      <View style={styles.barList}>
        {chart.categories.map((row) => (
          <View
            key={row.category}
            accessible
            accessibilityLabel={`${row.category}: ${spokenFigure(row.amountMinor, row.percentTenths, currency)}`}
            style={styles.barRow}
            testID={`category-row-${row.category}`}
          >
            <NameAndFigure name={row.category} value={figure(row.amountMinor, row.percentTenths, currency)} compact={compact} />
            <View
              style={[
                styles.bar,
                { width: `${(row.barFraction * 100).toFixed(3)}%`, backgroundColor: categoryColor(row.category, scheme, registry) },
              ]}
              testID={`bar-${row.category}`}
            />
          </View>
        ))}
      </View>
      <View style={styles.scale} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" testID="bar-scale">
        <Text style={styles.scaleText}>{formatMoney(0, currency)}</Text>
        <Text style={styles.scaleText}>{formatMoney(largest, currency)}</Text>
      </View>
    </View>
  );
}

function Swatch({ color }: { readonly color: string }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={[styles.swatch, { backgroundColor: color }]} />;
}

function LegendRow({ row, currency, compact }: { readonly row: ChartCategory; readonly currency: CurrencyConfig; readonly compact: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const { scheme } = useTheme();
  const registry = useCategoryRegistry();
  return (
    <View
      accessible
      accessibilityLabel={`${row.category}: ${spokenFigure(row.amountMinor, row.percentTenths, currency)}`}
      style={styles.legendRow}
      testID={`category-row-${row.category}`}
    >
      <Swatch color={categoryColor(row.category, scheme, registry)} />
      <NameAndFigure name={row.category} value={figure(row.amountMinor, row.percentTenths, currency)} compact={compact} />
    </View>
  );
}

function RemainingGroup({
  slice,
  currency,
  compact,
}: {
  readonly slice: Extract<PieSlice, { kind: 'remaining' }>;
  readonly currency: CurrencyConfig;
  readonly compact: boolean;
}) {
  const count = slice.categories.length;
  const styles = useThemedStyles(makeStyles);
  const { scheme } = useTheme();
  return (
    <View>
      <View
        accessible
        accessibilityLabel={`${REMAINING_CATEGORIES_LABEL}, ${count} categories: ${spokenFigure(slice.amountMinor, slice.percentTenths, currency)}`}
        style={styles.legendRow}
        testID="pie-remaining"
      >
        <Swatch color={remainingColor(scheme)} />
        <NameAndFigure name={REMAINING_CATEGORIES_LABEL} value={figure(slice.amountMinor, slice.percentTenths, currency)} compact={compact} />
      </View>
      <View style={styles.members}>
        {slice.categories.map((row) => (
          <View
            key={row.category}
            accessible
            accessibilityLabel={`${row.category}, in ${REMAINING_CATEGORIES_LABEL.toLowerCase()}: ${spokenFigure(row.amountMinor, row.percentTenths, currency)}`}
            style={styles.memberRow}
            testID={`category-row-${row.category}`}
          >
            <NameAndFigure name={row.category} value={figure(row.amountMinor, row.percentTenths, currency)} compact={compact} />
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * Up to five slices from the same totals as the bars. The list under the pie
 * names every original category with its exact amount, so nothing depends on
 * touching or reading the pie itself.
 */
export function CategoryPie({ chart, currency, compact, radius }: ChartProps & { readonly radius: number }) {
  const description = chart.slices
    .map((slice) => `${sliceName(slice)} ${spokenPercent(sliceTenths(slice), sliceAmount(slice))}`)
    .join(', ');
  const single = chart.slices.length === 1;
  const styles = useThemedStyles(makeStyles);
  const { scheme, colors } = useTheme();
  const registry = useCategoryRegistry();
  return (
    <View style={styles.pieBlock}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={`Pie chart of spending by category. ${description}.`}
        style={styles.pie}
        testID="pie-chart"
      >
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none">
          <PieChart
            data={chart.slices.map((slice) => ({ value: sliceAmount(slice), color: sliceColor(slice, scheme, registry) }))}
            radius={radius}
            // A 2 px gap in the card colour separates neighbouring slices.
            strokeWidth={single ? 0 : 2}
            strokeColor={colors.surface}
            backgroundColor={colors.surface}
          />
        </View>
      </View>
      <View style={styles.legend} testID="pie-breakdown">
        {chart.slices.map((slice) =>
          slice.kind === 'category' ? (
            <LegendRow key={slice.category.category} row={slice.category} currency={currency} compact={compact} />
          ) : (
            <RemainingGroup key="remaining" slice={slice} currency={currency} compact={compact} />
          ),
        )}
      </View>
    </View>
  );
}

function makeStyles({ colors }: Theme) {
  return StyleSheet.create({
    barList: {
      borderLeftWidth: 1,
      borderLeftColor: colors.chartAxis,
      gap: spacing.lg,
      paddingVertical: spacing.xs,
    },
    barRow: { gap: spacing.sm },
    bar: {
      height: 14,
      minWidth: MIN_BAR_WIDTH,
      borderTopRightRadius: 4,
      borderBottomRightRadius: 4,
    },
    scale: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      gap: spacing.sm,
      marginTop: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingTop: spacing.xs,
    },
    scaleText: { ...typography.caption, color: colors.textMuted, fontVariant: ['tabular-nums'] },
    // Grows beside a swatch; never flex: 1, which collapses inside a ScrollView column.
    text: { flexGrow: 1, flexShrink: 1, paddingLeft: spacing.sm },
    textStacked: { flexDirection: 'column' },
    textInline: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: spacing.md },
    name: { ...typography.body, color: colors.text },
    nameInline: { flexShrink: 1 },
    figure: { ...typography.bodyStrong, color: colors.text, fontVariant: ['tabular-nums'] },
    pieBlock: { gap: spacing.lg },
    pie: { alignItems: 'center', paddingVertical: spacing.sm },
    legend: { gap: spacing.sm },
    legendRow: { flexDirection: 'row', alignItems: 'center', minHeight: 32 },
    swatch: { width: 14, height: 14, borderRadius: radii.sm / 2 },
    members: {
      marginLeft: 6,
      marginTop: spacing.xs,
      paddingLeft: spacing.sm,
      borderLeftWidth: 1,
      borderLeftColor: colors.border,
      gap: spacing.xs,
    },
    memberRow: { minHeight: 28, justifyContent: 'center' },
  });
}
