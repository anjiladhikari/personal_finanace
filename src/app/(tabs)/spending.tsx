import { ScrollView, StyleSheet, Text } from 'react-native';

import { colors, spacing } from '@/ui/theme';

export default function MySpendingScreen() {
  return (
    <ScrollView contentContainerStyle={styles.content} testID="my-spending-screen">
      <Text style={styles.lead}>
        Totals and category charts by day, month, year or all time will appear here.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md },
  lead: { fontSize: 16, lineHeight: 22, color: colors.text },
});
