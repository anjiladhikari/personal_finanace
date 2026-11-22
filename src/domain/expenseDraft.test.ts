import { parseLocalDate, type LocalDate } from './dates';
import { EXPENSE_CATEGORIES } from './expense';
import { emptyDraft, validateExpenseDraft, type ExpenseDraft } from './expenseDraft';

const today = parseLocalDate('2026-11-22') as LocalDate;
const context = { minorUnits: 2, today };
const valid: ExpenseDraft = { description: 'Coffee', amountText: '4.50', category: 'Eating out', purchaseDate: '2026-11-22' };

test('initial categories', () => {
  expect(EXPENSE_CATEGORIES).toEqual(['Groceries', 'Eating out', 'Transport', 'Bills', 'Shopping', 'Health', 'Other']);
});

test('an empty draft defaults the date to today and is invalid', () => {
  expect(emptyDraft(today)).toEqual({ description: '', amountText: '', category: null, purchaseDate: '2026-11-22' });
  expect(validateExpenseDraft(emptyDraft(today), context)).toEqual({
    ok: false,
    errors: { description: 'empty', amount: 'empty', category: 'missing' },
  });
});

test('a valid draft becomes a trimmed payload in minor units', () => {
  expect(validateExpenseDraft({ ...valid, description: '  Coffee  ', amountText: ' 4.5 ' }, context)).toEqual({
    ok: true,
    payload: { purchaseDate: '2026-11-22', description: 'Coffee', amountMinor: 450, category: 'Eating out' },
  });
});

test.each<[Partial<ExpenseDraft>, object]>([
  [{ description: '   ' }, { description: 'empty' }],
  [{ amountText: '0' }, { amount: 'not_positive' }],
  [{ amountText: '-3' }, { amount: 'not_positive' }],
  [{ amountText: '4.505' }, { amount: 'too_many_decimals' }],
  [{ amountText: 'four' }, { amount: 'invalid_format' }],
  [{ category: 'Rent' }, { category: 'missing' }],
  [{ category: null }, { category: 'missing' }],
  [{ purchaseDate: '2026-11-23' }, { purchaseDate: 'in_future' }],
  [{ purchaseDate: '2026-02-30' }, { purchaseDate: 'invalid_date' }],
  [{ purchaseDate: '1999-12-31' }, { purchaseDate: 'before_earliest' }],
])('%o → %o', (patch, errors) => {
  expect(validateExpenseDraft({ ...valid, ...patch }, context)).toEqual({ ok: false, errors });
});

test('amount precision follows the configured currency', () => {
  expect(validateExpenseDraft({ ...valid, amountText: '1500' }, { minorUnits: 0, today })).toMatchObject({
    ok: true,
    payload: { amountMinor: 1500 },
  });
  expect(validateExpenseDraft({ ...valid, amountText: '15.5' }, { minorUnits: 0, today })).toEqual({
    ok: false,
    errors: { amount: 'too_many_decimals' },
  });
});

test('backdated purchases are accepted', () => {
  expect(validateExpenseDraft({ ...valid, purchaseDate: '2024-02-29' }, context)).toMatchObject({
    ok: true,
    payload: { purchaseDate: '2024-02-29' },
  });
});
