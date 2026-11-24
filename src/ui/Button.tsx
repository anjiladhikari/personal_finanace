import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from './Icon';
import { radii, spacing, TOUCH_TARGET, typography, useTheme, useThemedStyles, type Theme } from './theme';

interface Props {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: 'primary' | 'secondary';
  readonly disabled?: boolean;
  /** Shows a spinner in place of the icon (the label should say what is happening). */
  readonly busy?: boolean;
  readonly icon?: IconName;
  readonly testID?: string;
}

export function Button({ label, onPress, variant = 'primary', disabled = false, busy = false, icon, testID }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const primary = variant === 'primary';
  const tint = primary ? colors.onAccent : colors.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, busy }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        primary ? styles.primary : styles.secondary,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={tint} />
      ) : icon === undefined ? null : (
        <View>
          <Icon name={icon} color={tint} size={20} />
        </View>
      )}
      <Text style={[styles.label, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

function makeStyles({ colors }: Theme) {
  return StyleSheet.create({
    base: {
      minHeight: TOUCH_TARGET + 4,
      borderRadius: radii.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
    },
    primary: { backgroundColor: colors.accent },
    secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.outline },
    pressed: { opacity: 0.85 },
    disabled: { opacity: 0.55 },
    label: { ...typography.bodyStrong, textAlign: 'center', flexShrink: 1 },
  });
}
