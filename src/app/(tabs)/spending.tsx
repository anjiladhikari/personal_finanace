import DateTimePicker from '@react-native-community/datetimepicker';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { dataScopeOf, type AppSettings } from '@/db/appSettings';
import { useDatabase } from '@/db/DatabaseContext';
import { countConfirmedExpenses } from '@/db/ledgerCache';
import { useAppSettings } from '@/db/useAppSettings';
import {
  isDateInPeriod,
  localDateParts,
  makeLocalDate,
  MAX_SUPPORTED_YEAR,
  MIN_SUPPORTED_YEAR,
  periodContaining,
  periodRange,
  shiftPeriod,
  todayLocalDate,
  type LocalDate,
  type Period,
  type PeriodKind,
} from '@/domain/dates';
import type { DataScope } from '@/domain/expense';
import { formatMoney } from '@/domain/money';
import { spendingChart } from '@/domain/spendingChart';
import { useSubmissionEngine } from '@/sync/SubmissionEngineContext';
import { Button } from '@/ui/Button';
import { CategoryBars, CategoryPie } from '@/ui/SpendingCharts';
import { formatSyncTime, periodLabel, refreshFailureMessage, sheetIssueMessage } from '@/ui/spendingFormat';
import { colors, spacing } from '@/ui/theme';
import { useSpendingAnalysis, useSyncStatus } from '@/ui/useSpending';
import { useSpendingLayout, type SpendingLayout } from '@/ui/useSpendingLayout';

type ChartType = 'bar' | 'pie';

const KINDS: readonly { kind: PeriodKind; label: string }[] = [
  { kind: 'day', label: 'Day' },
  { kind: 'month', label: 'Month' },
  { kind: 'year', label: 'Year' },
  { kind: 'all', label: 'All time' },
];

const CHART_TYPES: readonly { type: ChartType; label: string }[] = [
  { type: 'bar', label: 'Bar' },
  { type: 'pie', label: 'Pie' },
];

const FIRST_PICKABLE = makeLocalDate(MIN_SUPPORTED_YEAR, 1, 1) as LocalDate;
const LAST_PICKABLE = makeLocalDate(MAX_SUPPORTED_YEAR, 12, 31) as LocalDate;

/**
 * A date inside the period, used to keep position when switching period kind
 * and to open the calendar: today if the period contains it, else its start.
 */
function anchorOf(period: Period): LocalDate {
  const today = todayLocalDate();
  return isDateInPeriod(today, period) ? today : (periodRange(period)?.start ?? today);
}

function toPickerDate(date: LocalDate): Date {
  const { year, month, day } = localDateParts(date);
  return new Date(year, month - 1, day);
}

/** The neighbouring period, or null past the supported calendar range. */
function neighbour(period: Period, steps: number): Period | null {
  try {
    return shiftPeriod(period, steps);
  } catch {
    return null;
  }
}

function PeriodKinds({ period, compact, onChange }: { readonly period: Period; readonly compact: boolean; readonly onChange: (period: Period) => void }) {
  return (
    <View style={styles.segments} accessibilityRole="radiogroup" accessibilityLabel="Period">
      {KINDS.map(({ kind, label }) => {
        const selected = period.kind === kind;
        return (
          <Pressable
            key={kind}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(periodContaining(kind, anchorOf(period)))}
            style={[styles.segment, compact && styles.segmentGrid, selected && styles.segmentSelected]}
            testID={`period-${kind}`}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function StepButton({ symbol, label, target, onChange, testID }: {
  readonly symbol: string;
  readonly label: string;
  readonly target: Period | null;
  readonly onChange: (period: Period) => void;
  readonly testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: target === null }}
      disabled={target === null}
      onPress={() => target !== null && onChange(target)}
      style={[styles.step, target === null && styles.dimmed]}
      testID={testID}
    >
      <Text style={styles.stepText}>{symbol}</Text>
    </Pressable>
  );
}

/** Previous / choose / next for day, month and year. All time needs no picker. */
function PeriodPicker({ period, onChange }: { readonly period: Period; readonly onChange: (period: Period) => void }) {
  const [picking, setPicking] = useState(false);
  if (period.kind === 'all') return null;
  const kind = period.kind;

  const onPicked = (_event: unknown, picked: Date) => {
    setPicking(false);
    onChange(periodContaining(kind, todayLocalDate(picked)));
  };

  return (
    <View style={styles.stepper}>
      <StepButton symbol="‹" label={`Previous ${kind}`} target={neighbour(period, -1)} onChange={onChange} testID="period-previous" />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Choose ${kind}`}
        accessibilityHint={kind === 'day' ? 'Opens a calendar' : `Opens a calendar; the ${kind} of the date you pick is shown`}
        onPress={() => setPicking(true)}
        style={styles.choose}
        testID="period-choose"
      >
        <Text style={styles.chooseText}>Choose {kind}</Text>
      </Pressable>
      <StepButton symbol="›" label={`Next ${kind}`} target={neighbour(period, 1)} onChange={onChange} testID="period-next" />
      {picking ? (
        <DateTimePicker
          value={toPickerDate(anchorOf(period))}
          mode="date"
          minimumDate={toPickerDate(FIRST_PICKABLE)}
          maximumDate={toPickerDate(LAST_PICKABLE)}
          onValueChange={onPicked}
          onDismiss={() => setPicking(false)}
          testID="period-date-picker"
        />
      ) : null}
    </View>
  );
}

function ChartToggle({ value, onChange }: { readonly value: ChartType; readonly onChange: (type: ChartType) => void }) {
  return (
    <View style={styles.segments} accessibilityRole="radiogroup" accessibilityLabel="Chart type">
      {CHART_TYPES.map(({ type, label }) => {
        const selected = value === type;
        return (
          <Pressable
            key={type}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(type)}
            style={[styles.segment, selected && styles.segmentSelected]}
            testID={`chart-${type}`}
          >
            <Text style={[styles.segmentText, selected && styles.segmentTextSelected]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Notice({ text, testID, busy = false }: { readonly text: string; readonly testID: string; readonly busy?: boolean }) {
  return (
    <View style={styles.notice} testID={testID} accessibilityLiveRegion="polite">
      {busy ? <ActivityIndicator color={colors.accent} /> : null}
      <Text style={styles.noticeText}>{text}</Text>
    </View>
  );
}

/**
 * Selected period, total, chart toggle and chart. Everything here comes from
 * one analysis result, so the period, total, bars, slices and percentages
 * always describe the same query.
 */
function Results({ scope, settings, period, chartType, onChartType, layout }: {
  readonly scope: DataScope;
  readonly settings: AppSettings;
  readonly period: Period;
  readonly chartType: ChartType;
  readonly onChartType: (type: ChartType) => void;
  readonly layout: SpendingLayout;
}) {
  const state = useSpendingAnalysis(scope, period);
  const engine = useSubmissionEngine();
  const status = useSyncStatus(engine);
  const analysis = state.status === 'ready' ? state.analysis : null;
  const chart = useMemo(() => (analysis === null ? null : spendingChart(analysis)), [analysis]);

  if (state.status === 'loading') return <Notice text="Loading saved expenses…" testID="spending-loading" busy />;
  if (state.status === 'error' || analysis === null || chart === null) {
    return <Notice text="Couldn’t read the expenses saved on this phone. Close and reopen the app to try again." testID="spending-error" />;
  }

  const currency = settings.currency;
  const total = formatMoney(chart.totalMinor, currency);
  const blocking = state.issues.filter((issue) => issue.kind !== 'duplicate_resolved');
  const neverLoaded = analysis.lastSuccessfulSyncAt === null;

  let empty: ReactNode = null;
  if (chart.categories.length === 0) {
    empty =
      neverLoaded && status.kind === 'refreshing' ? (
        <Notice text="Loading your expenses from Google Sheets…" testID="spending-empty" busy />
      ) : neverLoaded ? (
        <Notice text="Your Google Sheet hasn’t been loaded yet. Use Refresh below to load it." testID="spending-empty" />
      ) : (
        <Notice text="No confirmed expenses in this period." testID="spending-empty" />
      );
  }

  return (
    <View style={styles.results} testID="spending-results">
      <View style={styles.summary} accessibilityLiveRegion="polite">
        <Text style={styles.periodLabel} accessibilityRole="header" testID="period-label">
          {periodLabel(analysis.period)}
        </Text>
        <View accessible accessibilityLabel={`Total spent ${total}`}>
          <Text style={styles.totalLabel}>Total spent</Text>
          <Text style={styles.total} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} testID="period-total">
            {total}
          </Text>
        </View>
      </View>

      {empty ?? (
        <>
          <ChartToggle value={chartType} onChange={onChartType} />
          <View style={styles.card}>
            {chartType === 'bar' ? (
              <CategoryBars chart={chart} currency={currency} compact={layout.compact} />
            ) : (
              <CategoryPie chart={chart} currency={currency} compact={layout.compact} radius={layout.pieRadius} />
            )}
          </View>
        </>
      )}

      {analysis.excludedRowCount > 0 ? (
        <View style={styles.issues} testID="sheet-issues">
          <Text style={styles.issuesTitle}>
            Totals exclude {analysis.excludedRowCount} row{analysis.excludedRowCount === 1 ? '' : 's'} in your sheet that need fixing:
          </Text>
          {blocking.map((issue) => (
            <Text key={issue.rowNumber} style={styles.issue}>
              Row {issue.rowNumber}: {sheetIssueMessage(issue.kind)}.
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function SyncBar({ settings }: { readonly settings: AppSettings }) {
  const engine = useSubmissionEngine();
  const status = useSyncStatus(engine);
  const refreshing = status.kind === 'refreshing';

  let line: string;
  if (refreshing) {
    const progress = status.progress;
    line =
      progress === null || progress.rowsRead === 0
        ? 'Refreshing from Google Sheets…'
        : `Refreshing… ${progress.rowsRead}${progress.totalRows === null ? '' : ` of ${progress.totalRows - 1}`} rows read`;
  } else if (status.kind === 'failed') {
    line = refreshFailureMessage(status.code);
  } else {
    line =
      settings.lastSuccessfulSyncAt === null
        ? 'Not refreshed yet.'
        : `Showing saved results. Last refreshed ${formatSyncTime(settings.lastSuccessfulSyncAt)}.`;
  }

  return (
    <View style={styles.syncBar}>
      <View style={styles.syncLine}>
        {refreshing ? <ActivityIndicator color={colors.accent} testID="sync-busy" /> : null}
        <Text style={[styles.syncText, status.kind === 'failed' && styles.syncError]} accessibilityLiveRegion="polite" testID="sync-status">
          {line}
        </Text>
      </View>
      {status.kind === 'failed' && settings.lastSuccessfulSyncAt !== null ? (
        <Text style={styles.syncText} testID="last-refresh">
          Last successful refresh {formatSyncTime(settings.lastSuccessfulSyncAt)}.
        </Text>
      ) : null}
      <Button
        variant="secondary"
        label={refreshing ? 'Refreshing…' : 'Refresh'}
        onPress={() => void engine.refresh()}
        disabled={refreshing}
        testID="refresh"
      />
    </View>
  );
}

/**
 * Shows cached spending immediately. On the first visit with an empty cache
 * it loads the sheet; afterwards only the Refresh button contacts Google.
 * Opens on the current month as bars.
 */
export default function MySpendingScreen() {
  const db = useDatabase();
  const engine = useSubmissionEngine();
  const settingsState = useAppSettings();
  const settings = settingsState.status === 'ready' ? settingsState.settings : null;
  const scope = useMemo(() => (settings === null ? null : dataScopeOf(settings)), [settings]);
  const [period, setPeriod] = useState<Period>(() => periodContaining('month', todayLocalDate()));
  const [chartType, setChartType] = useState<ChartType>('bar');
  const layout = useSpendingLayout();
  const firstLoadChecked = useRef(false);

  useEffect(() => {
    if (settings === null || scope === null || firstLoadChecked.current) return;
    firstLoadChecked.current = true;
    if (settings.lastSuccessfulSyncAt !== null) return;
    void countConfirmedExpenses(db, scope).then((count) => {
      if (count === 0) void engine.refresh();
    });
  }, [db, engine, settings, scope]);

  return (
    <ScrollView contentContainerStyle={styles.content} testID="my-spending-screen">
      {settingsState.status === 'error' ? (
        <Notice text="Couldn’t read this phone’s settings. Close and reopen the app to try again." testID="spending-error" />
      ) : settings === null || scope === null ? (
        <Notice text="Loading saved expenses…" testID="spending-loading" busy />
      ) : (
        <>
          <PeriodKinds period={period} compact={layout.compact} onChange={setPeriod} />
          <PeriodPicker period={period} onChange={setPeriod} />
          <Results scope={scope} settings={settings} period={period} chartType={chartType} onChartType={setChartType} layout={layout} />
          <SyncBar settings={settings} />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, paddingBottom: spacing.lg, gap: spacing.md },
  segments: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  segment: {
    flexGrow: 1,
    flexBasis: 0,
    minHeight: 48,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Two per row on narrow screens or with large text.
  segmentGrid: { flexBasis: '45%' },
  segmentSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  segmentText: { fontSize: 15, color: colors.text, textAlign: 'center' },
  segmentTextSelected: { color: '#FFFFFF', fontWeight: '600' },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  step: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontSize: 28, color: colors.accent },
  dimmed: { opacity: 0.4 },
  choose: {
    flexShrink: 1,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chooseText: { fontSize: 16, color: colors.accent, fontWeight: '600', textAlign: 'center' },
  results: { gap: spacing.md },
  summary: { gap: spacing.xs },
  periodLabel: { fontSize: 20, fontWeight: '700', color: colors.text },
  totalLabel: { fontSize: 15, color: colors.textMuted },
  total: { fontSize: 32, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
  },
  notice: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  noticeText: { flexShrink: 1, fontSize: 15, color: colors.textMuted },
  syncBar: { gap: spacing.sm, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  syncLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  syncText: { flexShrink: 1, fontSize: 14, color: colors.textMuted },
  syncError: { color: '#C62828' },
  issues: { backgroundColor: '#FFF4E5', borderRadius: 10, padding: spacing.md, gap: spacing.xs },
  issuesTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  issue: { fontSize: 14, color: colors.textMuted },
});
