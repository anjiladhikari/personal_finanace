import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from './Icon';
import { radii, spacing, typography, useTheme, useThemedStyles, type Theme } from './theme';

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: IconName;
}

interface Props<T extends string> {
  readonly options: readonly SegmentOption<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  /** Spoken name of the group, e.g. "Period". */
  readonly accessibilityLabel: string;
  /** Wrap into two columns (narrow screens or large text). */
  readonly wrap?: boolean;
  readonly testIDPrefix: string;
}

/**
 * A compact radio group. Segments are 40 dp tall inside a 4 dp track, and
 * the hit area extends to 48 dp. The selected segment is filled with the
 * accent colour and announced as checked.
 */
export function Segmented<T extends string>({ options, value, onChange, accessibilityLabel, wrap = false, testIDPrefix }: Props<T>) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={[styles.track, wrap && styles.trackWrap]} accessibilityRole="radiogroup" accessibilityLabel={accessibilityLabel}>
      {options.map((option) => {
        const selected = option.value === value;
        const tint = selected ? colors.onAccent : colors.text;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            hitSlop={{ top: 4, bottom: 4 }}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [styles.segment, wrap && styles.segmentWrap, selected && styles.selected, pressed && !selected && styles.pressed]}
            testID={`${testIDPrefix}-${option.value}`}
          >
            {option.icon === undefined ? null : <Icon name={option.icon} color={tint} size={18} />}
            <Text style={[styles.text, selected && styles.textSelected]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function makeStyles({ colors }: Theme) {
  return StyleSheet.create({
    track: {
      flexDirection: 'row',
      padding: spacing.xs,
      gap: spacing.xs,
      borderRadius: radii.md,
      backgroundColor: colors.surfaceMuted,
    },
    trackWrap: { flexWrap: 'wrap' },
    segment: {
      flexGrow: 1,
      flexBasis: 0,
      minHeight: 40,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: radii.sm,
    },
    // Two per row.
    segmentWrap: { flexBasis: '45%' },
    selected: { backgroundColor: colors.accent },
    pressed: { backgroundColor: colors.surface },
    text: { ...typography.label, color: colors.text, textAlign: 'center', flexShrink: 1 },
    textSelected: { color: colors.onAccent, fontWeight: '700' },
  });
}
