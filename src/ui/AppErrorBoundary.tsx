import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Appearance, Text, View } from 'react-native';

import { diagnosticCodeFor, logDiagnostic } from '@/diagnostics/log';

import { spacing, themes, typography } from './theme';

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
    // A class component cannot use hooks; read the appearance directly.
    const { colors } = themes[Appearance.getColorScheme() === 'dark' ? 'dark' : 'light'];
    return (
      <View
        style={{ flex: 1, justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.background }}
        accessibilityRole="alert"
      >
        <Text style={{ ...typography.title, color: colors.text, marginBottom: spacing.sm }}>Something went wrong</Text>
        <Text style={{ ...typography.body, color: colors.textMuted }}>
          Close the app and open it again. Expenses you have already saved stay on this phone.
        </Text>
      </View>
    );
  }
}
