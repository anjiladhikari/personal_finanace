import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { SPREADSHEET_NAME } from '@/domain/sheetContract';
import { Button } from '@/ui/Button';
import { ConnectionPanel } from '@/ui/ConnectionPanel';
import { colors, spacing } from '@/ui/theme';
import { useGoogleConnection } from '@/ui/useGoogleConnection';

/** First-run setup: connect Google and create or find the expense spreadsheet. */
export default function SetupScreen() {
  const { ui, run } = useGoogleConnection();

  const connect = async (request: Parameters<typeof run>[0]) => {
    const result = await run(request);
    if (result?.kind === 'ready') router.replace('/');
  };

  return (
    <ScrollView contentContainerStyle={styles.content} testID="setup-screen">
      <Text style={styles.heading}>Keep your expenses in your own Google Drive</Text>
      <Text style={styles.body}>
        The app saves each expense to a spreadsheet called “{SPREADSHEET_NAME}” in your Google Drive. It can only
        see files it creates, never your other files.
      </Text>
      {ui.status === 'idle' ? (
        <Button
          label="Connect Google"
          onPress={() => void connect({ interactive: true })}
          testID="connect-google"
        />
      ) : (
        <ConnectionPanel ui={ui} onRun={(request) => void connect(request)} />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.md },
  heading: { fontSize: 22, fontWeight: '700', color: colors.text },
  body: { fontSize: 16, lineHeight: 22, color: colors.textMuted },
});
