import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { dataScopeOf, type AppSettings } from '@/db/appSettings';
import { useDatabase } from '@/db/DatabaseContext';
import { countConfirmedExpenses } from '@/db/ledgerCache';
import { useAppSettings } from '@/db/useAppSettings';
import {
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
import { useSubmissionEngine } from '@/sync/SubmissionEngineContext';
import { Button } from '@/ui/Button';
import { formatSyncTime, periodLabel, refreshFailureMessage, sheetIssueMessage } from '@/ui/spendingFormat';
import { colors, spacing } from '@/ui/theme';
import { useSpendingAnalysis, useSyncStatus } from '@/ui/useSpending';

const KINDS: readonly { kind: PeriodKind; label: string }[] = [
  { kind: 'day', label: 'Day' },
  { kind: 'month', label: 'Month' },
  { kind: 'year', label: 'Year' },
  { kind: 'all', label: 'All time' },
];

/** A date inside the period, used to keep position when switching period kind. */
function anchorOf(period: Period): LocalDate {
  return periodRange(period)?.start ?? todayLocalDate();
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
    line = settings.lastSuccessfulSyncAt === null ? 'Not refreshed yet.' : `Last refreshed ${formatSyncTime(settings.lastSuccessfulSyncAt)}.`;
  }

  return (
    <View style={styles.syncBar}>
      <Text style={[styles.syncText, status.kind === 'failed' && styles.syncError]} accessibilityLiveRegion="polite" testID="sync-status">
        {line}
      </Text>
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

function PeriodPicker({ period, onChange }: { readonly period: Period; readonly onChange: (period: Period) => void }) {
  return (
    <View style={styles.picker}>
      <View style={styles.kinds} accessibilityRole="radiogroup" accessibilityLabel="Period">
        {KINDS.map(({ kind, label }) => {
          const selected = period.kind === kind;
          return (
            <Pressable
              key={kind}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              onPress={() => onChange(periodContaining(kind, anchorOf(period)))}
              style={[styles.kind, selected && styles.kindSelected]}
              testID={`period-${kind}`}
            >
              <Text style={[styles.kindText, selected && styles.kindTextSelected]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.stepper}>
        {period.kind === 'all' ? null : (
          <Pressable accessibilityRole="button" accessibilityLabel="Previous period" onPress={() => onChange(shiftPeriod(period, -1))} testID="period-previous" style={styles.step}>
            <Text style={styles.stepText}>‹</Text>
          </Pressable>
        )}
        <Text style={styles.periodLabel} testID="period-label">
          {periodLabel(period)}
        </Text>
        {period.kind === 'all' ? null : (
          <Pressable accessibilityRole="button" accessibilityLabel="Next period" onPress={() => onChange(shiftPeriod(period, 1))} testID="period-next" style={styles.step}>
            <Text style={styles.stepText}>›</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function Results({ scope, settings, period }: { readonly scope: DataScope; readonly settings: AppSettings; readonly period: Period }) {
  const state = useSpendingAnalysis(scope, period);
  if (state.status !== 'ready') return null;
  const { analysis, issues } = state;
  const currency = settings.currency;
  const blocking = issues.filter((issue) => issue.kind !== 'duplicate_resolved');

  return (
    <View style={styles.results} testID="spending-results">
      <Text style={styles.totalLabel}>Total</Text>
      <Text style={styles.total} testID="period-total">
        {formatMoney(analysis.totalMinor, currency)}
      </Text>
      {analysis.categories.length === 0 ? (
        <Text style={styles.empty}>No confirmed expenses in this period.</Text>
      ) : (
        analysis.categories.map((share) => (
          <View key={share.category} style={styles.categoryRow} testID={`category-row-${share.category}`}>
            <Text style={styles.categoryName}>{share.category}</Text>
            <Text style={styles.categoryAmount}>
              {formatMoney(share.amountMinor, currency)} · {share.percentage.toFixed(2)}%
            </Text>
          </View>
        ))
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

/**
 * Shows cached spending immediately. On the first visit with an empty cache
 * it loads the sheet; afterwards only the Refresh button contacts Google.
 */
export default function MySpendingScreen() {
  const db = useDatabase();
  const engine = useSubmissionEngine();
  const settingsState = useAppSettings();
  const settings = settingsState.status === 'ready' ? settingsState.settings : null;
  const scope = useMemo(() => (settings === null ? null : dataScopeOf(settings)), [settings]);
  const [period, setPeriod] = useState<Period>(() => periodContaining('month', todayLocalDate()));
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
      {settings === null || scope === null ? null : (
        <>
          <SyncBar settings={settings} />
          <PeriodPicker period={period} onChange={setPeriod} />
          <Results scope={scope} settings={settings} period={period} />
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.md },
  syncBar: { gap: spacing.sm },
  syncText: { fontSize: 14, color: colors.textMuted },
  syncError: { color: '#C62828' },
  picker: { gap: spacing.sm },
  kinds: { flexDirection: 'row', gap: spacing.xs },
  kind: {
    flex: 1,
    minHeight: 40,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  kindSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  kindText: { fontSize: 14, color: colors.text },
  kindTextSelected: { color: '#FFFFFF', fontWeight: '600' },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.md },
  step: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  stepText: { fontSize: 24, color: colors.accent },
  periodLabel: { fontSize: 17, fontWeight: '600', color: colors.text, minWidth: 140, textAlign: 'center' },
  results: { gap: spacing.sm },
  totalLabel: { fontSize: 14, color: colors.textMuted },
  total: { fontSize: 32, fontWeight: '700', color: colors.text },
  empty: { fontSize: 15, color: colors.textMuted },
  categoryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  categoryName: { fontSize: 16, color: colors.text },
  categoryAmount: { fontSize: 16, color: colors.text },
  issues: { backgroundColor: '#FFF4E5', borderRadius: 10, padding: spacing.md, gap: spacing.xs, marginTop: spacing.sm },
  issuesTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  issue: { fontSize: 14, color: colors.textMuted },
});
