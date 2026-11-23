import { StyleSheet, Text, View } from 'react-native';
import { PieChart } from 'react-native-gifted-charts';

import { formatMoney, type CurrencyConfig } from '@/domain/money';
import { REMAINING_CATEGORIES_LABEL, type ChartCategory, type PieSlice, type SpendingChart } from '@/domain/spendingChart';

import { categoryColor, REMAINING_COLOR } from './categoryColors';
import { formatPercent, spokenPercent } from './spendingFormat';
import { colors, spacing } from './theme';

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

function sliceColor(slice: PieSlice): string {
  return slice.kind === 'category' ? categoryColor(slice.category.category) : REMAINING_COLOR;
}

/** Category name and exact amount; stacked on narrow screens or with large text. */
function NameAndFigure({ name, value, compact }: { readonly name: string; readonly value: string; readonly compact: boolean }) {
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
                { width: `${(row.barFraction * 100).toFixed(3)}%`, backgroundColor: categoryColor(row.category) },
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
  return <View style={[styles.swatch, { backgroundColor: color }]} />;
}

function LegendRow({ row, currency, compact }: { readonly row: ChartCategory; readonly currency: CurrencyConfig; readonly compact: boolean }) {
  return (
    <View
      accessible
      accessibilityLabel={`${row.category}: ${spokenFigure(row.amountMinor, row.percentTenths, currency)}`}
      style={styles.legendRow}
      testID={`category-row-${row.category}`}
    >
      <Swatch color={categoryColor(row.category)} />
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
  return (
    <View>
      <View
        accessible
        accessibilityLabel={`${REMAINING_CATEGORIES_LABEL}, ${count} categories: ${spokenFigure(slice.amountMinor, slice.percentTenths, currency)}`}
        style={styles.legendRow}
        testID="pie-remaining"
      >
        <Swatch color={REMAINING_COLOR} />
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
            data={chart.slices.map((slice) => ({ value: sliceAmount(slice), color: sliceColor(slice) }))}
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

const styles = StyleSheet.create({
  barList: {
    borderLeftWidth: 1,
    borderLeftColor: colors.textMuted,
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  barRow: { gap: spacing.xs },
  bar: {
    height: 16,
    minWidth: MIN_BAR_WIDTH,
    borderTopRightRadius: 4,
    borderBottomRightRadius: 4,
  },
  scale: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.xs,
  },
  scaleText: { fontSize: 13, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  // Grows beside a swatch; never flex: 1, which collapses inside a ScrollView column.
  text: { flexGrow: 1, flexShrink: 1, paddingLeft: spacing.sm },
  textStacked: { flexDirection: 'column' },
  textInline: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: spacing.md },
  name: { fontSize: 16, color: colors.text },
  nameInline: { flexShrink: 1 },
  figure: { fontSize: 16, color: colors.text, fontVariant: ['tabular-nums'] },
  pieBlock: { gap: spacing.md },
  pie: { alignItems: 'center' },
  legend: { gap: spacing.sm },
  legendRow: { flexDirection: 'row', alignItems: 'center', minHeight: 32 },
  swatch: { width: 14, height: 14, borderRadius: 3 },
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
