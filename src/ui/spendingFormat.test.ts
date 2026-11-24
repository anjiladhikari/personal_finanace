import { parseLocalDate, type LocalDate } from '@/domain/dates';

import { formatPercent, groupThousands, purchaseDateLabel, spokenPercent, spokenPurchaseDate } from './spendingFormat';

const d = (value: string) => parseLocalDate(value) as LocalDate;

test('displayed percentages always show one decimal so a column lines up', () => {
  expect(formatPercent(875, 5_250)).toBe('87.5%');
  expect(formatPercent(410, 64_000)).toBe('41.0%');
  expect(formatPercent(1_000, 1)).toBe('100.0%');
  expect(formatPercent(0, 1)).toBe('<0.1%');
});

test('spoken percentages drop a trailing .0', () => {
  expect(spokenPercent(410, 1)).toBe('41 percent');
  expect(spokenPercent(875, 1)).toBe('87.5 percent');
  expect(spokenPercent(0, 1)).toBe('less than 0.1 percent');
});

test('row counts are grouped in thousands', () => {
  expect(groupThousands(0)).toBe('0');
  expect(groupThousands(2_000)).toBe('2,000');
  expect(groupThousands(36_500)).toBe('36,500');
  expect(groupThousands(1_234_567)).toBe('1,234,567');
});

test('purchase dates read naturally, with today and yesterday named', () => {
  const today = d('2026-11-24');
  expect(purchaseDateLabel(today, today)).toBe('Today · Tue 24 Nov 2026');
  expect(purchaseDateLabel(d('2026-11-23'), today)).toBe('Yesterday · Mon 23 Nov 2026');
  expect(purchaseDateLabel(d('2024-02-29'), today)).toBe('Thu 29 Feb 2024');
  expect(spokenPurchaseDate(today, today)).toBe('today, Tuesday 24 November 2026');
});
