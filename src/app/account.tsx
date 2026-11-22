import * as Linking from 'expo-linking';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAppSettings } from '@/db/useAppSettings';
import { SPREADSHEET_NAME } from '@/domain/sheetContract';
import { Button } from '@/ui/Button';
import { ConnectionPanel } from '@/ui/ConnectionPanel';
import { colors, spacing } from '@/ui/theme';
import { useGoogleConnection } from '@/ui/useGoogleConnection';

/** Shows the bound account and lets the user check or repair the connection. */
export default function AccountScreen() {
  const settings = useAppSettings();
  const { ui, run } = useGoogleConnection();
  const bound = settings.status === 'ready' ? settings.settings : null;

  const openSheet = () => {
    if (bound?.spreadsheetId == null) return;
    const gid = bound.expensesSheetId === null ? '' : `#gid=${bound.expensesSheetId}`;
    void Linking.openURL(
      `https://docs.google.com/spreadsheets/d/${encodeURIComponent(bound.spreadsheetId)}/edit${gid}`,
    );
  };

  return (
    <ScrollView contentContainerStyle={styles.content} testID="account-screen">
      <View style={styles.card}>
        <Text style={styles.label}>Google account</Text>
        <Text style={styles.value} testID="account-email">
          {bound?.googleAccountEmail ?? 'Not connected'}
        </Text>
        <Text style={styles.label}>Spreadsheet</Text>
        <Text style={styles.value}>{bound?.spreadsheetId == null ? 'Not set up' : `“${SPREADSHEET_NAME}”`}</Text>
      </View>

      {bound?.spreadsheetId == null ? null : (
        <Button variant="secondary" label="Open in Google Sheets" onPress={openSheet} testID="open-sheet" />
      )}
      <Button
        label="Check connection"
        onPress={() => void run({ interactive: false })}
        disabled={ui.status === 'working'}
        testID="check-connection"
      />
      <ConnectionPanel ui={ui} onRun={(request) => void run(request)} />
      <Button
        variant="secondary"
        label="Use a different Google account"
        onPress={() => void run({ interactive: true, selectAccount: true })}
        disabled={ui.status === 'working'}
        testID="choose-account"
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  label: { fontSize: 13, color: colors.textMuted },
  value: { fontSize: 16, color: colors.text, marginBottom: spacing.sm },
});
