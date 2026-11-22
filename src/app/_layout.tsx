import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { DatabaseProvider } from '@/db/DatabaseProvider';
import { GoogleServicesProvider } from '@/google/GoogleServicesContext';

// The tab group (Add expense first) is the base of the stack.
export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  return (
    <DatabaseProvider>
      <GoogleServicesProvider>
        <StatusBar style="dark" />
        <Stack>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen
            name="setup"
            options={{ title: 'Set up', headerBackVisible: false, gestureEnabled: false }}
          />
          <Stack.Screen name="account" options={{ title: 'Google account', presentation: 'modal' }} />
        </Stack>
      </GoogleServicesProvider>
    </DatabaseProvider>
  );
}
