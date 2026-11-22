import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors } from './theme';

export function LoadingScreen() {
  return (
    <View style={styles.container} accessibilityLabel="Loading">
      <ActivityIndicator size="large" color={colors.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
});
