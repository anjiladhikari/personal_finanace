import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { onSubmissionsChanged } from '@/db/changes';
import { useDatabase } from '@/db/DatabaseContext';
import { listPendingSubmissions, type PendingSubmission } from '@/db/pendingSubmissions';
import type { DataScope } from '@/domain/expense';
import { formatMoney, type CurrencyConfig } from '@/domain/money';
import { ATTEMPT_WARNING_THRESHOLD } from '@/domain/submissionPolicy';
import { useSubmissionEngine } from '@/sync/SubmissionEngineContext';

import { Button } from './Button';
import { submissionStatusLabel } from './submissionLabels';
import { colors, spacing } from './theme';

/** Every saved expense not yet confirmed in Google Sheets, with its state. */
export function UnresolvedSubmissions({ scope, currency }: { readonly scope: DataScope; readonly currency: CurrencyConfig }) {
  const db = useDatabase();
  const engine = useSubmissionEngine();
  const [items, setItems] = useState<PendingSubmission[]>([]);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let active = true;
    const load = () => {
      listPendingSubmissions(db, scope).then(
        (rows) => active && setItems(rows),
        () => undefined,
      );
    };
    load();
    const unsubscribe = onSubmissionsChanged(load);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [db, scope]);

  if (items.length === 0) return null;

  const retry = async () => {
    setRetrying(true);
    try {
      await engine.retry();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <View style={styles.section} testID="unresolved-list">
      <Text style={styles.heading}>Not yet in Google Sheets ({items.length})</Text>
      {items.map((item) => (
        <View key={item.submissionId} style={styles.row} testID={`unresolved-${item.submissionId}`}>
          <Text style={styles.title}>
            {item.description} · {formatMoney(item.amountMinor, currency)} · {item.purchaseDate}
          </Text>
          <Text style={styles.status}>
            {submissionStatusLabel(item.state, item.lastError?.code ?? null)}
            {item.attemptCount >= ATTEMPT_WARNING_THRESHOLD ? ` Tried ${item.attemptCount} times.` : ''}
          </Text>
        </View>
      ))}
      <Button variant="secondary" label={retrying ? 'Retrying…' : 'Retry now'} onPress={() => void retry()} disabled={retrying} testID="retry-now" />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm, marginTop: spacing.lg },
  heading: { fontSize: 16, fontWeight: '600', color: colors.text },
  row: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    gap: 2,
  },
  title: { fontSize: 15, color: colors.text },
  status: { fontSize: 13, color: colors.textMuted },
});
