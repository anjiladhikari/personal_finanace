import { parseLocalDate, type LocalDate } from './dates';
import { parseSheetRow, toSheetRow } from './sheetRow';

const payload = {
  purchaseDate: parseLocalDate('2026-11-21') as LocalDate,
  description: '=HYPERLINK("http://x")',
  amountMinor: 123_456,
  category: 'Bills',
};

describe('toSheetRow', () => {
  test('column order, literal text, ISO date and numeric major-unit amount', () => {
    expect(toSheetRow('id-1', payload, 2)).toEqual(['2026-11-21', '=HYPERLINK("http://x")', 1234.56, 'Bills', 'id-1']);
  });

  test.each([
    [1, 2, 0.01],
    [10, 2, 0.1],
    [110, 2, 1.1],
    [29, 2, 0.29],
    [99_999_999, 2, 999999.99],
    [1500, 0, 1500],
    [1234, 3, 1.234],
  ])('%i minor units (%i decimals) → %f', (amountMinor, minorUnits, expected) => {
    expect(toSheetRow('id', { ...payload, amountMinor }, minorUnits)[2]).toBe(expected);
  });
});

describe('parseSheetRow', () => {
  test('round-trips what the app writes', () => {
    for (const amountMinor of [1, 29, 110, 435, 123_456, 99_999_999]) {
      const row = toSheetRow('id-1', { ...payload, amountMinor }, 2);
      expect(parseSheetRow(row, 2)).toEqual({ expenseId: 'id-1', ...payload, amountMinor });
    }
  });

  test('accepts a Sheets date serial if the user re-typed the date', () => {
    // 46347 = 2026-11-21 (days since 1899-12-30)
    expect(parseSheetRow([46347, 'Bus', 3.8, 'Transport', 'id-2'], 2)).toMatchObject({ purchaseDate: '2026-11-21' });
  });

  test.each([
    [['not a date', 'Bus', 3.8, 'Transport', 'x']],
    [['2026-11-21', 'Bus', 'abc', 'Transport', 'x']],
    [['2026-11-21', 'Bus', 3.805, 'Transport', 'x']],
    [['2026-11-21', 'Bus', 3.8, '', 'x']],
    [['2026-11-21', 'Bus', 3.8, 'Transport', '']],
    [[]],
  ])('rejects %o', (row) => {
    expect(parseSheetRow(row, 2)).toBeNull();
  });
});
