import { Tabs } from 'expo-router';

import { colors } from '@/ui/theme';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        // Text-only tabs until the icon set is chosen.
        tabBarIconStyle: { display: 'none' },
        tabBarLabelStyle: { fontSize: 15, fontWeight: '600' },
        sceneStyle: { backgroundColor: colors.background },
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
