import { Link, Redirect, Tabs } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import { isSetupComplete } from '@/db/appSettings';
import { useAppSettings } from '@/db/useAppSettings';
import { LoadingScreen } from '@/ui/LoadingScreen';
import { colors, spacing } from '@/ui/theme';

function AccountLink() {
  return (
    <Link href="/account" style={styles.headerLink} testID="open-account">
      <Text style={styles.headerLinkText}>Account</Text>
    </Link>
  );
}

/**
 * Tabs open only after setup. The gate reads local settings only, so Add
 * expense never waits on a Google request.
 */
export default function TabsLayout() {
  const settings = useAppSettings();
  if (settings.status === 'loading') return <LoadingScreen />;
  if (settings.status === 'ready' && !isSetupComplete(settings.settings)) {
    return <Redirect href="/setup" />;
  }

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        // Text-only tabs until the icon set is chosen.
        tabBarIconStyle: { display: 'none' },
        tabBarLabelStyle: { fontSize: 15, fontWeight: '600' },
        sceneStyle: { backgroundColor: colors.background },
        headerRight: () => <AccountLink />,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Add expense', tabBarButtonTestID: 'tab-add-expense' }}
      />
      <Tabs.Screen
        name="spending"
        options={{ title: 'My spending', tabBarButtonTestID: 'tab-my-spending' }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  headerLink: { paddingHorizontal: spacing.md },
  headerLinkText: { color: colors.accent, fontSize: 16, fontWeight: '600' },
});
