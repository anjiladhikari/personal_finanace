import { useMemo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { dataScopeOf } from '@/db/appSettings';
import { useAppSettings } from '@/db/useAppSettings';
import { ExpenseForm } from '@/ui/ExpenseForm';
import { colors, spacing } from '@/ui/theme';
import { UnresolvedSubmissions } from '@/ui/UnresolvedSubmissions';

/**
 * Initial route. Renders from local data only; it must never wait for a
 * Google Sheets request.
 */
export default function AddExpenseScreen() {
  const settings = useAppSettings();
  const ready = settings.status === 'ready' ? settings.settings : null;
  const scope = useMemo(() => (ready === null ? null : dataScopeOf(ready)), [ready]);

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      style={styles.screen}
      testID="add-expense-screen"
    >
      {ready === null ? null : <ExpenseForm currency={ready.currency} />}
      {ready === null || scope === null ? null : <UnresolvedSubmissions scope={scope} currency={ready.currency} />}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background },
  content: { padding: spacing.md },
});
