import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { diagnosticCodeFor, logDiagnostic } from '@/diagnostics/log';

import { colors, spacing } from './theme';

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly failed: boolean;
}

/**
 * Last-resort boundary. Shows a fixed message and logs only a diagnostic
 * code, never the error text (which could quote user data).
 */
export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    logDiagnostic('app.render_failed', { code: diagnosticCodeFor(error) });
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <View style={styles.container} accessibilityRole="alert">
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.body}>
          Close the app and open it again. Expenses you have already saved stay on this phone.
        </Text>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing.lg,
    backgroundColor: colors.background,
  },
  title: { fontSize: 20, fontWeight: '600', color: colors.text, marginBottom: spacing.sm },
  body: { fontSize: 16, lineHeight: 22, color: colors.textMuted },
});
