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
import { Icon, type IconName } from '@/ui/Icon';
import { Segmented, type SegmentOption } from '@/ui/Segmented';
import { CategoryBars, CategoryPie } from '@/ui/SpendingCharts';
import { formatSyncTime, groupThousands, periodLabel, refreshFailureMessage, sheetIssueMessage } from '@/ui/spendingFormat';
import { radii, spacing, TOUCH_TARGET, typography, useTheme, useThemedStyles, type Theme } from '@/ui/theme';
import { usePendingCount, useSpendingAnalysis, useSyncStatus } from '@/ui/useSpending';
import { useSpendingLayout, type SpendingLayout } from '@/ui/useSpendingLayout';

type ChartType = 'bar' | 'pie';

const KINDS: readonly SegmentOption<PeriodKind>[] = [
  { value: 'day', label: 'Day' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'all', label: 'All time' },
];

const CHART_TYPES: readonly SegmentOption<ChartType>[] = [
  { value: 'bar', label: 'Bar', icon: 'bars' },
  { value: 'pie', label: 'Pie', icon: 'pie' },
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

function StepButton({ icon, label, target, onChange, testID }: {
  readonly icon: IconName;
  readonly label: string;
  readonly target: Period | null;
  readonly onChange: (period: Period) => void;
  readonly testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: target === null }}
      disabled={target === null}
      onPress={() => target !== null && onChange(target)}
      style={({ pressed }) => [styles.step, pressed && styles.pressed, target === null && styles.dimmed]}
      testID={testID}
    >
      <Icon name={icon} color={colors.accent} size={24} />
    </Pressable>
  );
}

/**
 * One row: previous, the selected period (tap to pick a date), next.
 * All time has no neighbours, so only its name is shown.
 */
function PeriodNavigator({ period, onChange }: { readonly period: Period; readonly onChange: (period: Period) => void }) {
  const [picking, setPicking] = useState(false);
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const label = periodLabel(period);

  if (period.kind === 'all') {
    return (
      <View style={styles.navRow} testID="period-nav">
        <Text style={styles.navLabelStatic} accessibilityRole="header" testID="period-label">
          {label}
        </Text>
      </View>
    );
  }
  const kind = period.kind;
  const onPicked = (_event: unknown, picked: Date) => {
    setPicking(false);
    onChange(periodContaining(kind, todayLocalDate(picked)));
  };

  return (
    <View style={styles.navRow} testID="period-nav">
      <StepButton icon="chevron-left" label={`Previous ${kind}`} target={neighbour(period, -1)} onChange={onChange} testID="period-previous" />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}. Choose ${kind}`}
        accessibilityHint={kind === 'day' ? 'Opens a calendar' : `Opens a calendar; the ${kind} of the date you pick is shown`}
        onPress={() => setPicking(true)}
        style={({ pressed }) => [styles.navLabelButton, pressed && styles.pressed]}
        testID="period-choose"
      >
        <Text style={styles.navLabel} testID="period-label">
          {label}
        </Text>
        <Icon name="chevron-down" color={colors.textMuted} size={18} />
      </Pressable>
      <StepButton icon="chevron-right" label={`Next ${kind}`} target={neighbour(period, 1)} onChange={onChange} testID="period-next" />
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

function Notice({ text, testID, busy = false, icon }: { readonly text: string; readonly testID: string; readonly busy?: boolean; readonly icon?: IconName }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.notice} testID={testID} accessibilityLiveRegion="polite">
      {busy ? <ActivityIndicator color={colors.accent} /> : icon === undefined ? null : <Icon name={icon} color={colors.textMuted} size={28} />}
      <Text style={styles.noticeText}>{text}</Text>
    </View>
  );
}

/**
 * Total, then the category breakdown. Everything here comes from one
 * analysis result, so the total, bars, slices and percentages always
 * describe the same query.
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
  const styles = useThemedStyles(makeStyles);
  const analysis = state.status === 'ready' ? state.analysis : null;
  const chart = useMemo(() => (analysis === null ? null : spendingChart(analysis)), [analysis]);

  if (state.status === 'loading') return <Notice text="Loading saved expenses…" testID="spending-loading" busy />;
  if (state.status === 'error' || analysis === null || chart === null) {
    return <Notice text="Couldn’t read the expenses saved on this phone. Close and reopen the app to try again." testID="spending-error" icon="alert" />;
  }

  const currency = settings.currency;
  const total = formatMoney(chart.totalMinor, currency);
  const blocking = state.issues.filter((issue) => issue.kind !== 'duplicate_resolved');
  const neverLoaded = analysis.lastSuccessfulSyncAt === null;
  const single = chart.categories.length === 1 ? chart.categories[0] : undefined;

  let empty: ReactNode = null;
  if (chart.categories.length === 0) {
    empty =
      neverLoaded && status.kind === 'refreshing' ? (
        <Notice text="Loading your expenses from Google Sheets…" testID="spending-empty" busy />
      ) : neverLoaded ? (
        <Notice text="Your Google Sheet hasn’t been loaded yet. Use Refresh below to load it." testID="spending-empty" icon="refresh" />
      ) : (
        <Notice text="No confirmed expenses in this period." testID="spending-empty" icon="chart" />
      );
  }

  return (
    <View style={styles.results} testID="spending-results">
      <View style={styles.hero} accessible accessibilityLabel={`Total spent, ${periodLabel(analysis.period)}: ${total}`} accessibilityLiveRegion="polite">
        <Text style={styles.heroLabel}>Total spent</Text>
        <Text style={styles.heroAmount} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} maxFontSizeMultiplier={1.5} testID="period-total">
          {total}
        </Text>
      </View>

      <View style={styles.card} testID="breakdown-card">
        <View style={[styles.cardHeader, layout.compact && styles.cardHeaderStacked]}>
          <Text style={styles.cardTitle} accessibilityRole="header">
            By category
          </Text>
          {empty === null ? (
            <View style={layout.compact ? undefined : styles.chartToggle}>
              <Segmented options={CHART_TYPES} value={chartType} onChange={onChartType} accessibilityLabel="Chart type" testIDPrefix="chart" />
            </View>
          ) : null}
        </View>
        {empty ??
          (chartType === 'bar' ? (
            <CategoryBars chart={chart} currency={currency} compact={layout.compact} />
          ) : (
            <CategoryPie chart={chart} currency={currency} compact={layout.compact} radius={layout.pieRadius} />
          ))}
        {single === undefined ? null : (
          <Text style={styles.cardNote} testID="single-category-note">
            All spending in this period is in {single.category}.
          </Text>
        )}
      </View>

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

function StatusRow({ icon, title, children, tone = 'normal' }: {
  readonly icon: IconName;
  readonly title: string;
  readonly children: ReactNode;
  readonly tone?: 'normal' | 'error';
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.statusRow}>
      <Icon name={icon} color={tone === 'error' ? colors.danger : colors.accent} size={22} />
      <View style={styles.statusText}>
        <Text style={styles.statusTitle}>{title}</Text>
        {children}
      </View>
    </View>
  );
}

/**
 * Saves from this phone and full-history refreshes are separate: each has
 * its own state and its own last-success time.
 */
function SyncStatusCard({ settings, scope }: { readonly settings: AppSettings; readonly scope: DataScope }) {
  const engine = useSubmissionEngine();
  const status = useSyncStatus(engine);
  const pending = usePendingCount(scope);
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const refreshing = status.kind === 'refreshing';

  let refreshLine: string;
  if (refreshing) {
    const progress = status.progress;
    refreshLine =
      progress === null || progress.rowsRead === 0
        ? 'Refreshing from Google Sheets…'
        : `Refreshing… ${groupThousands(progress.rowsRead)}${progress.totalRows === null ? '' : ` of ${groupThousands(progress.totalRows - 1)}`} rows read`;
  } else if (status.kind === 'failed') {
    refreshLine = refreshFailureMessage(status.code);
  } else {
    refreshLine =
      settings.lastSuccessfulSyncAt === null
        ? 'Not refreshed yet.'
        : `Last refreshed ${formatSyncTime(settings.lastSuccessfulSyncAt)}. Showing saved results.`;
  }

  const saveLine =
    pending !== null && pending > 0
      ? `${pending} expense${pending === 1 ? '' : 's'} waiting to be sent to Google Sheets.`
      : settings.lastConfirmedSaveAt === null
        ? 'No expenses saved from this phone yet.'
        : `All sent. Last confirmed ${formatSyncTime(settings.lastConfirmedSaveAt)}.`;

  return (
    <View style={styles.card} testID="sync-card">
      <StatusRow icon={pending !== null && pending > 0 ? 'clock' : 'check-circle'} title="Saves from this phone">
        <Text style={styles.statusBody} accessibilityLiveRegion="polite" testID="save-status">
          {saveLine}
        </Text>
      </StatusRow>
      <View style={styles.divider} />
      <StatusRow icon={status.kind === 'failed' ? 'alert' : 'refresh'} title="Full history from Google Sheets" tone={status.kind === 'failed' ? 'error' : 'normal'}>
        <View style={styles.syncLine}>
          {refreshing ? <ActivityIndicator color={colors.accent} testID="sync-busy" /> : null}
          <Text style={[styles.statusBody, status.kind === 'failed' && styles.statusError]} accessibilityLiveRegion="polite" testID="sync-status">
            {refreshLine}
          </Text>
        </View>
        {status.kind === 'failed' && settings.lastSuccessfulSyncAt !== null ? (
          <Text style={styles.statusBody} testID="last-refresh">
            Last successful refresh {formatSyncTime(settings.lastSuccessfulSyncAt)}.
          </Text>
        ) : null}
      </StatusRow>
      <Button
        variant="secondary"
        icon="refresh"
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
  const styles = useThemedStyles(makeStyles);
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
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} testID="my-spending-screen">
      {settingsState.status === 'error' ? (
        <Notice text="Couldn’t read this phone’s settings. Close and reopen the app to try again." testID="spending-error" icon="alert" />
      ) : settings === null || scope === null ? (
        <Notice text="Loading saved expenses…" testID="spending-loading" busy />
      ) : (
        <>
          <Segmented
            options={KINDS}
            value={period.kind}
            onChange={(kind) => setPeriod(periodContaining(kind, anchorOf(period)))}
            accessibilityLabel="Period"
            wrap={layout.compact}
            testIDPrefix="period"
          />
          <PeriodNavigator period={period} onChange={setPeriod} />
          <Results scope={scope} settings={settings} period={period} chartType={chartType} onChartType={setChartType} layout={layout} />
          <SyncStatusCard settings={settings} scope={scope} />
        </>
      )}
    </ScrollView>
  );
}

function makeStyles({ colors }: Theme) {
  return StyleSheet.create({
    screen: { backgroundColor: colors.background },
    content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
    navRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, minHeight: TOUCH_TARGET },
    step: { width: TOUCH_TARGET, height: TOUCH_TARGET, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
    pressed: { backgroundColor: colors.surfaceMuted },
    dimmed: { opacity: 0.35 },
    navLabelButton: {
      flexShrink: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      minHeight: TOUCH_TARGET,
      paddingHorizontal: spacing.md,
      borderRadius: radii.pill,
    },
    navLabel: { ...typography.title, fontSize: 18, lineHeight: 24, color: colors.text, textAlign: 'center', flexShrink: 1 },
    navLabelStatic: { ...typography.title, color: colors.text, textAlign: 'center' },
    results: { gap: spacing.lg },
    hero: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.sm },
    heroLabel: { ...typography.label, color: colors.textMuted },
    heroAmount: { ...typography.display, color: colors.text, fontVariant: ['tabular-nums'] },
    card: {
      backgroundColor: colors.surface,
      borderRadius: radii.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      padding: spacing.lg,
      gap: spacing.lg,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
    cardHeaderStacked: { flexDirection: 'column', alignItems: 'stretch' },
    cardTitle: { ...typography.bodyStrong, color: colors.text },
    chartToggle: { minWidth: 168 },
    cardNote: { ...typography.caption, color: colors.textMuted },
    notice: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
    noticeText: { ...typography.body, fontSize: 15, color: colors.textMuted, flexShrink: 1 },
    issues: { backgroundColor: colors.warningSoft, borderRadius: radii.md, padding: spacing.lg, gap: spacing.xs },
    issuesTitle: { ...typography.label, fontWeight: '600', color: colors.text },
    issue: { ...typography.caption, color: colors.textMuted },
    statusRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
    statusText: { flexShrink: 1, flexGrow: 1, gap: 2 },
    statusTitle: { ...typography.label, fontWeight: '600', color: colors.text },
    statusBody: { ...typography.caption, color: colors.textMuted, flexShrink: 1 },
    statusError: { color: colors.danger },
    syncLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  });
}
