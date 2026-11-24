import { Link, Redirect, Tabs } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import { isSetupComplete } from '@/db/appSettings';
import { useAppSettings } from '@/db/useAppSettings';
import { Icon } from '@/ui/Icon';
import { LoadingScreen } from '@/ui/LoadingScreen';
import { spacing, typography, useTheme } from '@/ui/theme';

function AccountLink() {
  const { colors } = useTheme();
  return (
    <Link href="/account" style={styles.headerLink} testID="open-account" accessibilityLabel="Google account">
      <Text style={[styles.headerLinkText, { color: colors.accent }]}>Account</Text>
    </Link>
  );
}

/**
 * Tabs open only after setup. The gate reads local settings only, so Add
 * expense never waits on a Google request.
 */
export default function TabsLayout() {
  const settings = useAppSettings();
  const { colors } = useTheme();
  if (settings.status === 'loading') return <LoadingScreen />;
  if (settings.status === 'ready' && !isSetupComplete(settings.settings)) {
    return <Redirect href="/setup" />;
  }

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarLabelStyle: { ...typography.label, fontWeight: '600' },
        // The keyboard covers the tab bar anyway; hiding it keeps Save directly above the keyboard.
        tabBarHideOnKeyboard: true,
        headerStyle: { backgroundColor: colors.surface },
        headerTitleStyle: { ...typography.title, color: colors.text },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: colors.background },
        headerRight: () => <AccountLink />,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Add expense',
          tabBarButtonTestID: 'tab-add-expense',
          tabBarIcon: ({ color }) => <Icon name="add" color={color} />,
        }}
      />
      <Tabs.Screen
        name="spending"
        options={{
          title: 'My spending',
          tabBarButtonTestID: 'tab-my-spending',
          tabBarIcon: ({ color }) => <Icon name="chart" color={color} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  headerLink: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  headerLinkText: { ...typography.bodyStrong },
});
