import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';

import { DatabaseProvider } from '@/db/DatabaseProvider';
import { GoogleServicesProvider } from '@/google/GoogleServicesContext';
import { SubmissionEngineProvider } from '@/sync/SubmissionEngineContext';
import { CategoryRegistryProvider } from '@/ui/CategoryRegistry';
import { useTheme } from '@/ui/theme';

type NavigationTheme = typeof DefaultTheme;

// The tab group (Add expense first) is the base of the stack.
export const unstable_settings = {
  anchor: '(tabs)',
};

/** Headers, tab bar and screen backgrounds follow the app's light or dark tokens. */
function useNavigationTheme(): NavigationTheme {
  const { scheme, colors } = useTheme();
  return useMemo(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      dark: scheme === 'dark',
      colors: {
        ...base.colors,
        primary: colors.accent,
        background: colors.background,
        card: colors.surface,
        text: colors.text,
        border: colors.border,
        notification: colors.danger,
      },
    };
  }, [scheme, colors]);
}

export default function RootLayout() {
  const theme = useNavigationTheme();
  return (
    <DatabaseProvider>
      <GoogleServicesProvider>
        <SubmissionEngineProvider>
          <CategoryRegistryProvider>
            <ThemeProvider value={theme}>
              <StatusBar style="auto" />
              <Stack>
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen
                  name="setup"
                  options={{ title: 'Set up', headerBackVisible: false, gestureEnabled: false }}
                />
                <Stack.Screen name="account" options={{ title: 'Google account', presentation: 'modal' }} />
              </Stack>
            </ThemeProvider>
          </CategoryRegistryProvider>
        </SubmissionEngineProvider>
      </GoogleServicesProvider>
    </DatabaseProvider>
  );
}
