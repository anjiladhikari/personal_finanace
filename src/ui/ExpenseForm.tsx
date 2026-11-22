import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { EARLIEST_PURCHASE_DATE, localDateParts, todayLocalDate, type LocalDate } from '@/domain/dates';
import { EXPENSE_CATEGORIES } from '@/domain/expense';
import type { ExpenseDraftErrors } from '@/domain/expenseDraft';
import type { CurrencyConfig } from '@/domain/money';

import { Button } from './Button';
import { submissionStatusLabel } from './submissionLabels';
import { colors, spacing } from './theme';
import { useExpenseForm, type FormNotice } from './useExpenseForm';

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

const NOTICES: Record<Exclude<FormNotice, null>, string> = {
  saved: 'Saved to Google Sheets.',
  saved_sheet_only: 'Saved to Google Sheets. This phone will catch up automatically.',
  storage_failed: 'Couldn’t save on this phone. Your entry is still here. Try again.',
  not_set_up: 'Connect Google before saving expenses.',
};

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
  return (
    <View style={styles.field}>
      <Text style={styles.label} nativeID={nativeID}>
        {label}
      </Text>
      {children}
      {error === undefined ? null : (
        <Text style={styles.error} accessibilityLiveRegion="polite" testID={`${nativeID}-error`}>
          {error}
        </Text>
      )}
    </View>
  );
}

function toPickerDate(date: LocalDate): Date {
  const { year, month, day } = localDateParts(date);
  return new Date(year, month - 1, day);
}

export function ExpenseForm({ currency }: { readonly currency: CurrencyConfig }) {
  const form = useExpenseForm(currency.minorUnits);
  const [pickingDate, setPickingDate] = useState(false);
  const { draft, errors, status, locked } = form;
  const today = todayLocalDate();

  const onDatePicked = (event: DateTimePickerEvent, picked?: Date) => {
    setPickingDate(false);
    if (event.type === 'set' && picked !== undefined) form.update({ purchaseDate: todayLocalDate(picked) });
  };

  return (
    <View style={styles.form} testID="expense-form">
      <Field label={`Amount (${currency.code})`} nativeID="amount" error={errors.amount && amountMessage(errors.amount, currency.minorUnits)}>
        <TextInput
          style={[styles.input, errors.amount !== undefined && styles.inputError]}
          value={draft.amountText}
          onChangeText={(amountText) => form.update({ amountText })}
          keyboardType="decimal-pad"
          inputMode="decimal"
          placeholder="0.00"
          editable={!locked}
          accessibilityLabel={`Amount in ${currency.code}`}
          testID="amount-input"
        />
      </Field>

      <Field label="Description" nativeID="description" error={errors.description && 'Enter a description.'}>
        <TextInput
          style={[styles.input, errors.description !== undefined && styles.inputError]}
          value={draft.description}
          onChangeText={(description) => form.update({ description })}
          placeholder="What was it?"
          editable={!locked}
          accessibilityLabel="Description"
          testID="description-input"
        />
      </Field>

      <Field label="Category" nativeID="category" error={errors.category && 'Choose a category.'}>
        <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="Category">
          {EXPENSE_CATEGORIES.map((category) => {
            const selected = draft.category === category;
            return (
              <Pressable
                key={category}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: locked }}
                disabled={locked}
                onPress={() => form.update({ category })}
                style={[styles.chip, selected && styles.chipSelected]}
                testID={`category-${category}`}
              >
                <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{category}</Text>
              </Pressable>
            );
          })}
        </View>
      </Field>

      <Field label="Date" nativeID="date" error={errors.purchaseDate && dateMessage(errors.purchaseDate)}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Purchase date, ${draft.purchaseDate === today ? 'today' : draft.purchaseDate}. Change date`}
          disabled={locked}
          onPress={() => setPickingDate(true)}
          style={styles.input}
          testID="date-button"
        >
          <Text style={styles.inputText}>{draft.purchaseDate === today ? `Today (${today})` : draft.purchaseDate}</Text>
        </Pressable>
        {pickingDate ? (
          <DateTimePicker
            value={toPickerDate(draft.purchaseDate as LocalDate)}
            mode="date"
            maximumDate={toPickerDate(today)}
            minimumDate={toPickerDate(EARLIEST_PURCHASE_DATE)}
            onChange={onDatePicked}
          />
        ) : null}
      </Field>

      {status.kind === 'unresolved' ? (
        <View style={styles.banner} testID="unresolved-banner" accessibilityLiveRegion="polite">
          <Text style={styles.bannerTitle}>Saved on this phone, not yet in Google Sheets</Text>
          <Text style={styles.bannerBody}>{submissionStatusLabel(status.state, status.error)}</Text>
        </View>
      ) : null}
      {form.notice === null ? null : (
        <Text style={styles.notice} accessibilityLiveRegion="polite" testID="form-notice">
          {NOTICES[form.notice]}
        </Text>
      )}

      <Button
        label={status.kind === 'saving' ? 'Saving…' : 'Save expense'}
        onPress={() => void form.save()}
        disabled={status.kind === 'saving'}
        testID="save-expense"
      />
      {status.kind === 'unresolved' ? (
        <Button variant="secondary" label="New expense" onPress={form.startNew} testID="new-expense" />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md },
  field: { gap: spacing.xs },
  label: { fontSize: 14, fontWeight: '600', color: colors.text },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
    fontSize: 17,
    color: colors.text,
    justifyContent: 'center',
  },
  inputText: { fontSize: 17, color: colors.text },
  inputError: { borderColor: '#C62828' },
  error: { fontSize: 13, color: '#C62828' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  chipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { fontSize: 15, color: colors.text },
  chipTextSelected: { color: '#FFFFFF', fontWeight: '600' },
  banner: { backgroundColor: '#FFF4E5', borderRadius: 10, padding: spacing.md, gap: spacing.xs },
  bannerTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  bannerBody: { fontSize: 14, color: colors.textMuted },
  notice: { fontSize: 14, color: colors.textMuted },
});
