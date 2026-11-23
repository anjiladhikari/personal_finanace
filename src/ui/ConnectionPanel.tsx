import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { todayLocalDate } from '@/domain/dates';
import { EXPENSE_COLUMNS, SPREADSHEET_NAME } from '@/domain/sheetContract';
import type { ConnectionRequest, ConnectionState, SpreadsheetCandidate } from '@/sync/connection';

import { Button } from './Button';
import { colors, spacing } from './theme';
import type { ConnectionUiState } from './useGoogleConnection';

interface Props {
  readonly ui: ConnectionUiState;
  readonly onRun: (request: ConnectionRequest) => void;
}

const HEADER_TEXT = EXPENSE_COLUMNS.join(' | ');

function shortDate(iso: string | null): string {
  if (iso === null) return 'unknown';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'unknown' : todayLocalDate(date);
}

function Message({ title, body }: { readonly title: string; readonly body?: string }) {
  return (
    <View style={styles.message} accessibilityRole="summary">
      <Text style={styles.title}>{title}</Text>
      {body === undefined ? null : <Text style={styles.body}>{body}</Text>}
    </View>
  );
}

function CandidateList({
  candidates,
  onRun,
}: {
  readonly candidates: readonly SpreadsheetCandidate[];
  readonly onRun: Props['onRun'];
}) {
  return (
    <View style={styles.actions}>
      {candidates.map((candidate) => (
        <Button
          key={candidate.id}
          variant="secondary"
          testID={`candidate-${candidate.id}`}
          label={`${candidate.name || SPREADSHEET_NAME} · created ${shortDate(candidate.createdTime)} · changed ${shortDate(candidate.modifiedTime)}`}
          onPress={() => onRun({ interactive: true, chosenSpreadsheetId: candidate.id })}
        />
      ))}
    </View>
  );
}

function ResultView({ result, onRun }: { readonly result: ConnectionState; readonly onRun: Props['onRun'] }) {
  const retry = () => onRun({ interactive: true });
  const createNew = () => onRun({ interactive: true, createNewSpreadsheet: true });

  switch (result.kind) {
    case 'ready':
      return (
        <Message
          title={`Connected as ${result.accountEmail}`}
          body={`Expenses are saved to “${SPREADSHEET_NAME}” in your Google Drive.`}
        />
      );
    case 'cancelled':
      return (
        <>
          <Message title="Google connection was cancelled" body="Nothing was changed. You can connect when you're ready." />
          <Button label="Connect Google" onPress={retry} testID="connect-google" />
        </>
      );
    case 'reconnect_required':
      return (
        <>
          <Message
            title="Google access needs to be renewed"
            body="Access has expired or was removed from your Google account. Expenses on this phone are kept."
          />
          <Button label="Reconnect Google" onPress={retry} testID="reconnect-google" />
        </>
      );
    case 'permission_missing':
      return (
        <>
          <Message
            title="Drive permission is needed"
            body="When Google asks, allow access to the files this app creates. The app cannot see any of your other files."
          />
          <Button label="Try again" onPress={retry} testID="retry" />
        </>
      );
    case 'account_mismatch': {
      const bound = result.boundEmail ?? 'the original account';
      const useBound = () =>
        onRun(
          result.boundEmail === null
            ? { interactive: true, selectAccount: true }
            : { interactive: true, accountEmail: result.boundEmail },
        );
      if (result.pendingCount > 0) {
        return (
          <>
            <Message
              title={`This phone is set up for ${bound}`}
              body={`${result.pendingCount} expense(s) are waiting to be saved to that account, so a different account can't be used. Choose ${bound} to continue.`}
            />
            <Button
              label={`Use ${bound}`}
              onPress={useBound}
              testID="choose-bound-account"
            />
          </>
        );
      }
      return (
        <>
          <Message
            title={`This phone is set up for ${bound}`}
            body={`You chose ${result.selectedEmail}. Switching uses that account's own “${SPREADSHEET_NAME}” spreadsheet.`}
          />
          <Button
            label={`Switch to ${result.selectedEmail}`}
            onPress={() => onRun({ interactive: true, accountEmail: result.selectedEmail, confirmAccountSwitch: true })}
            testID="confirm-switch"
          />
          <Button
            variant="secondary"
            label={`Keep ${bound}`}
            onPress={useBound}
            testID="choose-bound-account"
          />
        </>
      );
    }
    case 'choose_spreadsheet':
      return (
        <>
          <Message
            title={`More than one “${SPREADSHEET_NAME}” spreadsheet was found`}
            body="Choose the one this phone should use. The others are left untouched."
          />
          <CandidateList candidates={result.candidates} onRun={onRun} />
        </>
      );
    case 'spreadsheet_trashed':
      return (
        <>
          <Message
            title={`“${SPREADSHEET_NAME}” is in your Google Drive trash`}
            body="Restore it from the trash in Google Drive, then check again. Or start a new, empty spreadsheet."
          />
          <Button label="Check again" onPress={retry} testID="check-again" />
          <Button variant="secondary" label="Create a new spreadsheet" onPress={createNew} testID="create-new" />
        </>
      );
    case 'spreadsheet_missing':
      return (
        <>
          <Message
            title={`The app can't find “${SPREADSHEET_NAME}”`}
            body="It may have been deleted. Create a new one to keep saving expenses; anything waiting on this phone moves to it."
          />
          <Button label="Create a new spreadsheet" onPress={createNew} testID="create-new" />
          <Button variant="secondary" label="Check again" onPress={retry} testID="check-again" />
        </>
      );
    case 'schema_invalid':
      return (
        <>
          <Message
            title="The Expenses tab has changed"
            body={
              result.problem === 'data_without_header'
                ? `Row 1 is empty but there are rows below it. Put this header back in row 1: ${HEADER_TEXT}`
                : `Row 1 must be exactly: ${HEADER_TEXT}. Fix it in Google Sheets, then check again.`
            }
          />
          <Button label="Check again" onPress={retry} testID="check-again" />
        </>
      );
    case 'unavailable':
      return (
        <Message
          title="Google connection isn't available in this app build"
          body="Install the development or release build of the app. Expo Go can't connect to Google."
        />
      );
    case 'misconfigured':
      return (
        <Message
          title="This build isn't set up with Google yet"
          body="The Google Cloud project needs the Drive and Sheets APIs enabled and an Android OAuth client for this package name and signing certificate (see docs/google-cloud-setup.md)."
        />
      );
    case 'offline':
      return (
        <>
          <Message title="Can't reach Google" body="Check your internet connection and try again." />
          <Button label="Try again" onPress={retry} testID="retry" />
        </>
      );
    case 'failed':
      return (
        <>
          <Message title="Something went wrong talking to Google" body="Nothing on this phone was lost. Try again." />
          <Button label="Try again" onPress={retry} testID="retry" />
        </>
      );
  }
}

export function ConnectionPanel({ ui, onRun }: Props) {
  if (ui.status === 'working') {
    return (
      <View style={styles.working} accessibilityLiveRegion="polite">
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.body}>Connecting to Google…</Text>
      </View>
    );
  }
  if (ui.status === 'idle') return null;
  return (
    <View style={styles.actions} testID={`connection-${ui.result.kind}`}>
      <ResultView result={ui.result} onRun={onRun} />
    </View>
  );
}

const styles = StyleSheet.create({
  actions: { gap: spacing.sm },
  message: { gap: spacing.xs, marginBottom: spacing.sm },
  title: { fontSize: 17, fontWeight: '600', color: colors.text },
  body: { fontSize: 15, lineHeight: 21, color: colors.textMuted },
  working: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
});
