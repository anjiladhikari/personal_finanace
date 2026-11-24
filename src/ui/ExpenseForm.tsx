import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import { EARLIEST_PURCHASE_DATE, localDateParts, todayLocalDate, type LocalDate } from '@/domain/dates';
import { rankQuickCategories, type CategoryIconKey } from '@/domain/categories';
import type { DataScope } from '@/domain/expense';
import type { ExpenseDraftErrors } from '@/domain/expenseDraft';
import type { CurrencyConfig } from '@/domain/money';
import { useSubmissionEngine } from '@/sync/SubmissionEngineContext';

import { Button } from './Button';
import { CategoryPicker } from './CategoryPicker';
import { useCategoryRegistry, useCategoryUsage } from './CategoryRegistry';
import { Icon } from './Icon';
import { estimateChipWidth, SEE_MORE_LABEL, visibleQuickChips } from './quickChips';
import { formatSyncTime, purchaseDateLabel, spokenPurchaseDate } from './spendingFormat';
import { submissionStatusLabel } from './submissionLabels';
import { radii, spacing, TOUCH_TARGET, typography, useTheme, useThemedStyles, type Theme } from './theme';
import { useExpenseForm, type FormNotice } from './useExpenseForm';

/** How long the confirmation after a confirmed save stays on screen. */
export const CONFIRMATION_MS = 5_000;

function amountMessage(error: NonNullable<ExpenseDraftErrors['amount']>, minorUnits: number): string {
  switch (error) {
    case 'empty':
      return 'Enter an amount.';
    case 'invalid_format':
      return 'Enter a number, for example 12.50.';
    case 'too_many_decimals':
      return minorUnits === 0 ? 'Use a whole amount.' : `Use at most ${minorUnits} decimal places.`;
    case 'not_positive':
      return 'The amount must be more than 0.';
    case 'too_large':
      return 'That amount is too large.';
  }
}

function dateMessage(error: NonNullable<ExpenseDraftErrors['purchaseDate']>): string {
  switch (error) {
    case 'invalid_date':
      return 'Choose a valid date.';
    case 'in_future':
      return 'The date can’t be in the future.';
    case 'before_earliest':
      return 'Choose a date from 2000 onwards.';
  }
}

const CONFIRMATIONS = {
  saved: 'Saved to Google Sheets.',
  saved_sheet_only: 'Saved to Google Sheets. This phone will catch up automatically.',
} as const;

/** Recoverable problems, shown beside Save; the draft stays as typed. */
const FAILURES = {
  storage_failed: 'Couldn’t save on this phone. Your entry is still here. Try again.',
  not_set_up: 'Connect Google before saving expenses.',
} as const;

function isConfirmation(notice: FormNotice): notice is keyof typeof CONFIRMATIONS {
  return notice === 'saved' || notice === 'saved_sheet_only';
}

function Field({
  label,
  nativeID,
  error,
  children,
}: {
  readonly label: string;
  readonly nativeID: string;
  readonly error: string | undefined;
  readonly children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.field}>
      <Text style={styles.label} nativeID={nativeID}>
        {label}
      </Text>
      {children}
      {error === undefined ? null : (
        <View style={styles.errorRow}>
          <Icon name="alert" color={colors.danger} size={16} />
          <Text style={styles.error} accessibilityLiveRegion="polite" testID={`${nativeID}-error`}>
            {error}
          </Text>
        </View>
      )}
    </View>
  );
}

function toPickerDate(date: LocalDate): Date {
  const { year, month, day } = localDateParts(date);
  return new Date(year, month - 1, day);
}

interface Props {
  readonly currency: CurrencyConfig;
  /** Whose expenses rank the quick-access categories (null before setup). */
  readonly scope: DataScope | null;
  /** When Google last confirmed a save from this phone (separate from full refreshes). */
  readonly lastConfirmedSaveAt: string | null;
  /** Shown under the form, inside the scrolling area. */
  readonly children?: ReactNode;
}

/**
 * The amount leads; Save sits in a footer that stays directly above the
 * keyboard (edge-to-edge Android does not resize the window, so the view pads
 * itself by the keyboard height).
 */
export function ExpenseForm({ currency, scope, lastConfirmedSaveAt, children }: Props) {
  const registry = useCategoryRegistry();
  const engine = useSubmissionEngine();
  const form = useExpenseForm(currency.minorUnits, registry);
  const [pickingDate, setPickingDate] = useState(false);
  const { draft, errors, status, locked, notice, clearNotice } = form;
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const { width: windowWidth, fontScale } = useWindowDimensions();

  // Quick-access categories: most used in the last 90 days, then the defaults.
  // The order is fixed once the person starts entering an expense, and
  // refreshed for the next one.
  const usage = useCategoryUsage(scope);
  const ranking = useMemo(() => rankQuickCategories(usage, registry), [usage, registry]);
  const pristine = draft.amountText === '' && draft.description === '' && draft.category === null;
  const [held, setHeld] = useState<readonly string[] | null>(null);
  const quick = pristine || held === null ? ranking : held;
  const edit = (patch: Parameters<typeof form.update>[0]) => {
    if (pristine) setHeld(ranking);
    form.update(patch);
  };

  // Chips are measured on screen; until then a cautious estimate is used.
  const [chipsWidth, setChipsWidth] = useState<number | null>(null);
  const [measured, setMeasured] = useState<{ readonly fontScale: number; readonly widths: Readonly<Record<string, number>> }>({
    fontScale,
    widths: {},
  });
  const widthOf = (label: string) =>
    (measured.fontScale === fontScale ? measured.widths[label] : undefined) ?? estimateChipWidth(label, fontScale);
  const measure = (label: string) => (event: LayoutChangeEvent) => {
    const width = Math.ceil(event.nativeEvent.layout.width);
    setMeasured((current) =>
      current.fontScale === fontScale && current.widths[label] === width
        ? current
        : { fontScale, widths: { ...(current.fontScale === fontScale ? current.widths : {}), [label]: width } },
    );
  };
  const available = chipsWidth ?? windowWidth - 2 * spacing.lg;
  const chips = visibleQuickChips(quick, draft.category, available, widthOf);
  const toMeasure = [...new Set([...quick, ...(draft.category === null ? [] : [draft.category]), SEE_MORE_LABEL])];
  const [picking, setPicking] = useState(false);
  const today = todayLocalDate();

  // The confirmation is brief; failures stay until the next attempt.
  useEffect(() => {
    if (!isConfirmation(notice)) return undefined;
    const timer = setTimeout(clearNotice, CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [notice, clearNotice]);

  const onDatePicked = (event: DateTimePickerEvent, picked?: Date) => {
    setPickingDate(false);
    if (event.type === 'set' && picked !== undefined) edit({ purchaseDate: todayLocalDate(picked) });
  };

  const purchaseDate = draft.purchaseDate as LocalDate;
  const saving = status.kind === 'saving';

  return (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={headerHeight} style={styles.root} testID="expense-form">
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content} testID="expense-form-scroll">
        <Field label="Amount" nativeID="amount" error={errors.amount && amountMessage(errors.amount, currency.minorUnits)}>
          <View style={[styles.amountBox, errors.amount !== undefined && styles.boxError, locked && styles.locked]}>
            <View style={styles.currencyBadge} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <Text style={styles.currencyText} testID="currency-badge">
                {currency.code}
              </Text>
            </View>
            <TextInput
              style={styles.amountInput}
              value={draft.amountText}
              onChangeText={(amountText) => edit({ amountText })}
              keyboardType="decimal-pad"
              inputMode="decimal"
              placeholder="0.00"
              placeholderTextColor={colors.outline}
              maxFontSizeMultiplier={1.5}
              editable={!locked}
              accessibilityLabel={`Amount in ${currency.code}`}
              testID="amount-input"
            />
          </View>
        </Field>

        <Field label="Description" nativeID="description" error={errors.description && 'Enter a description.'}>
          <TextInput
            style={[styles.input, errors.description !== undefined && styles.boxError, locked && styles.locked]}
            value={draft.description}
            onChangeText={(description) => edit({ description })}
            placeholder="What was it?"
            placeholderTextColor={colors.textMuted}
            editable={!locked}
            returnKeyType="done"
            accessibilityLabel="Description"
            testID="description-input"
          />
        </Field>

        <Field label="Category" nativeID="category" error={errors.category && 'Choose a category.'}>
          <View
            style={styles.chips}
            accessibilityRole="radiogroup"
            accessibilityLabel="Category"
            onLayout={(event) => setChipsWidth(Math.floor(event.nativeEvent.layout.width))}
            testID="quick-categories"
          >
            {chips.map((name) => {
              const selected = draft.category === name;
              const tint = selected ? colors.onAccent : colors.text;
              const icon: CategoryIconKey = registry.find(name)?.icon ?? 'tag';
              return (
                <Pressable
                  key={name}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, disabled: locked }}
                  disabled={locked}
                  onPress={() => edit({ category: name })}
                  style={({ pressed }) => [
                    styles.chip,
                    selected && styles.chipSelected,
                    pressed && styles.pressed,
                    locked && styles.locked,
                  ]}
                  testID={`category-${name}`}
                >
                  <Icon name={selected ? 'check' : icon} color={tint} size={18} />
                  <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{name}</Text>
                </Pressable>
              );
            })}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="See more categories"
              accessibilityState={{ disabled: locked }}
              disabled={locked}
              onPress={() => setPicking(true)}
              style={({ pressed }) => [styles.chip, styles.moreChip, pressed && styles.pressed, locked && styles.locked]}
              testID="category-see-more"
            >
              <Icon name="grid" color={colors.accent} size={18} />
              <Text style={[styles.chipText, styles.moreText]}>{SEE_MORE_LABEL}</Text>
            </Pressable>
          </View>
          {/* Off-screen copies give each chip's real width, so exactly two rows are filled. */}
          <View style={styles.measure} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {toMeasure.map((name) => (
              <View key={name} style={styles.chip} onLayout={measure(name)}>
                <Icon name="grid" color={colors.text} size={18} />
                <Text style={[styles.chipText, styles.chipTextSelected]}>{name}</Text>
              </View>
            ))}
          </View>
          <CategoryPicker
            visible={picking}
            registry={registry}
            selected={draft.category}
            onSelect={(name) => {
              setPicking(false);
              edit({ category: name });
            }}
            onClose={() => setPicking(false)}
            onCreate={(name) => engine.createCategory(name, registry)}
          />
        </Field>

        <Field label="Date" nativeID="date" error={errors.purchaseDate && dateMessage(errors.purchaseDate)}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Purchase date, ${spokenPurchaseDate(purchaseDate, today)}. Change date`}
            disabled={locked}
            onPress={() => setPickingDate(true)}
            style={({ pressed }) => [styles.input, styles.dateRow, pressed && styles.pressed, locked && styles.locked]}
            testID="date-button"
          >
            <Icon name="calendar" color={colors.accent} size={20} />
            <Text style={styles.dateText}>{purchaseDateLabel(purchaseDate, today)}</Text>
            <Icon name="chevron-down" color={colors.textMuted} size={20} />
          </Pressable>
          {pickingDate ? (
            <DateTimePicker
              value={toPickerDate(purchaseDate)}
              mode="date"
              maximumDate={toPickerDate(today)}
              minimumDate={toPickerDate(EARLIEST_PURCHASE_DATE)}
              onChange={onDatePicked}
            />
          ) : null}
        </Field>

        {children}
      </ScrollView>

      <View style={styles.footer} testID="save-footer">
        {isConfirmation(notice) ? (
          <View style={styles.confirmation} accessibilityLiveRegion="polite" testID="save-confirmation">
            <Icon name="check-circle" color={colors.onInverse} size={20} />
            <Text style={styles.confirmationText} testID="form-notice">
              {CONFIRMATIONS[notice]}
            </Text>
          </View>
        ) : null}
        {notice === 'storage_failed' || notice === 'not_set_up' ? (
          <View style={styles.failure} accessibilityRole="alert" accessibilityLiveRegion="polite">
            <Icon name="alert" color={colors.danger} size={20} />
            <Text style={styles.failureText} testID="form-notice">
              {FAILURES[notice]}
            </Text>
          </View>
        ) : null}
        {status.kind === 'unresolved' ? (
          <View style={styles.pending} testID="unresolved-banner" accessibilityLiveRegion="polite">
            <Icon name="clock" color={colors.text} size={20} />
            <View style={styles.pendingText}>
              <Text style={styles.pendingTitle}>Saved on this phone, not yet in Google Sheets</Text>
              <Text style={styles.pendingBody}>{submissionStatusLabel(status.state, status.error)}</Text>
            </View>
          </View>
        ) : null}

        <Button
          label={saving ? 'Saving…' : status.kind === 'unresolved' ? 'Try saving again' : 'Save expense'}
          onPress={() => void form.save()}
          disabled={saving}
          busy={saving}
          testID="save-expense"
        />
        {status.kind === 'unresolved' ? (
          <Button variant="secondary" label="New expense" onPress={form.startNew} testID="new-expense" />
        ) : null}
        <Text style={styles.lastSaved} testID="last-confirmed-save">
          {lastConfirmedSaveAt === null
            ? 'No expenses saved to Google Sheets from this phone yet.'
            : `Last saved to Google Sheets ${formatSyncTime(lastConfirmedSaveAt)}.`}
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

function makeStyles({ colors }: Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    content: { padding: spacing.lg, gap: spacing.xl, paddingBottom: spacing.xl },
    field: { gap: spacing.sm },
    label: { ...typography.label, color: colors.textMuted },
    amountBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 72,
      paddingHorizontal: spacing.lg,
      borderRadius: radii.lg,
      borderWidth: 1,
      borderColor: colors.outline,
      backgroundColor: colors.surface,
    },
    currencyBadge: {
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: radii.sm,
      backgroundColor: colors.accentSoft,
    },
    currencyText: { ...typography.label, fontWeight: '700', color: colors.accent, letterSpacing: 0.5 },
    amountInput: {
      flex: 1,
      ...typography.display,
      color: colors.text,
      paddingVertical: spacing.sm,
      fontVariant: ['tabular-nums'],
    },
    input: {
      minHeight: TOUCH_TARGET + 4,
      borderWidth: 1,
      borderColor: colors.outline,
      borderRadius: radii.md,
      paddingHorizontal: spacing.lg,
      backgroundColor: colors.surface,
      ...typography.body,
      fontSize: 17,
      color: colors.text,
      justifyContent: 'center',
    },
    boxError: { borderColor: colors.danger, borderWidth: 2 },
    locked: { opacity: 0.6 },
    pressed: { opacity: 0.8 },
    errorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    error: { ...typography.caption, color: colors.danger, flexShrink: 1 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minHeight: TOUCH_TARGET - 4,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: colors.outline,
      backgroundColor: colors.surface,
    },
    chipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
    chipText: { ...typography.label, color: colors.text, flexShrink: 1 },
    chipTextSelected: { color: colors.onAccent, fontWeight: '700' },
    moreChip: { borderStyle: 'dashed', borderColor: colors.accent },
    moreText: { color: colors.accent, fontWeight: '600' },
    // Measured off screen; never visible, never in the accessibility tree.
    measure: { position: 'absolute', left: -10_000, top: 0, opacity: 0, flexDirection: 'row', alignItems: 'flex-start' },
    dateRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
    dateText: { ...typography.body, fontSize: 17, color: colors.text, flex: 1 },
    footer: {
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.md,
      backgroundColor: colors.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    confirmation: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
      borderRadius: radii.md,
      backgroundColor: colors.inverseSurface,
    },
    confirmationText: { ...typography.label, color: colors.onInverse, flexShrink: 1 },
    failure: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radii.md,
      backgroundColor: colors.dangerSoft,
    },
    failureText: { ...typography.label, color: colors.danger, flexShrink: 1 },
    pending: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radii.md,
      backgroundColor: colors.warningSoft,
    },
    pendingText: { flexShrink: 1, gap: 2 },
    pendingTitle: { ...typography.label, fontWeight: '600', color: colors.text },
    pendingBody: { ...typography.caption, color: colors.textMuted },
    lastSaved: { ...typography.caption, color: colors.textMuted, textAlign: 'center' },
  });
}
