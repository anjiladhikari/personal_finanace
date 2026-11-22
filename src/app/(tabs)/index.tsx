import { ScrollView, StyleSheet, Text } from 'react-native';

import { useAppSettings } from '@/db/useAppSettings';
import { colors, spacing } from '@/ui/theme';

/**
 * Initial route. Renders from local data only; it must never wait for a
 * Google Sheets request.
 */
export default function AddExpenseScreen() {
  const settings = useAppSettings();

  return (
    <ScrollView contentContainerStyle={styles.content} testID="add-expense-screen">
      <Text style={styles.lead}>
        Expenses are saved on this phone first, then copied to your Google Sheet.
      </Text>
      {settings.status === 'ready' ? (
        <Text style={styles.meta} testID="currency-note">
          Amounts are in {settings.settings.currency.code}.
        </Text>
      ) : null}
      <Text style={styles.placeholder}>The expense entry form is not available yet.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.sm },
  lead: { fontSize: 16, lineHeight: 22, color: colors.text },
  meta: { fontSize: 14, color: colors.textMuted },
  placeholder: { fontSize: 14, color: colors.textMuted, marginTop: spacing.md },
});
