import { ActivityIndicator, View } from 'react-native';

import { useTheme } from './theme';

export function LoadingScreen() {
  const { colors } = useTheme();
  return (
    <View
      style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}
      accessibilityLabel="Loading"
    >
      <ActivityIndicator size="large" color={colors.accent} />
    </View>
  );
}
