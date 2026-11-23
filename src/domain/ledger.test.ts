import { affectsTotals, buildLedger } from './ledger';

const row = (rowNumber: number, ...cells: unknown[]) => ({ rowNumber, cells });

test('valid rows become expenses with their row numbers; empty rows are skipped', () => {
  const ledger = buildLedger(
    [row(2, '2026-11-01', 'Rent', 500, 'Bills', 'a'), row(3), row(4, '', ' ', null, '', ''), row(5, '2026-11-02', '', '7', 'Other', 'b')],
    2,
  );
  expect(ledger.expenses).toEqual([
    { expenseId: 'a', rowNumber: 2, purchaseDate: '2026-11-01', description: 'Rent', amountMinor: 50_000, category: 'Bills' },
    { expenseId: 'b', rowNumber: 5, purchaseDate: '2026-11-02', description: '', amountMinor: 700, category: 'Other' },
  ]);
  expect(ledger.emptyRows).toBe(2);
  expect(ledger.issues).toEqual([]);
});

test('each invalid row is reported once with the most important problem', () => {
  const ledger = buildLedger(
    [
      row(2, 'bad', 'x', 'bad', '', ''), // no ID wins
      row(3, 'bad', 'x', 'bad', '', 'id3'), // then date
      row(4, '2026-11-01', 'x', 0, '', 'id4'), // then amount
      row(5, '2026-11-01', 'x', 1, ' ', 'id5'), // then category
    ],
    2,
  );
  expect(ledger.issues).toEqual([
    { rowNumber: 2, kind: 'missing_id', expenseId: null },
    { rowNumber: 3, kind: 'invalid_date', expenseId: 'id3' },
    { rowNumber: 4, kind: 'invalid_amount', expenseId: 'id4' },
    { rowNumber: 5, kind: 'missing_category', expenseId: 'id5' },
  ]);
  expect([...ledger.idsInSheet].sort()).toEqual(['id3', 'id4', 'id5']);
});

test('exact duplicates count once; the earliest row is kept', () => {
  const ledger = buildLedger(
    [row(7, '2026-11-01', 'Rent', 500, 'Bills', 'a'), row(9, '2026-11-01', ' Rent ', '500.00', 'Bills', 'a')],
    2,
  );
  expect(ledger.expenses.map((e) => e.rowNumber)).toEqual([7]);
  expect(ledger.issues).toEqual([{ rowNumber: 9, kind: 'duplicate_resolved', expenseId: 'a' }]);
  expect(affectsTotals('duplicate_resolved')).toBe(false);
});

test('conflicting duplicates are all excluded and all reported', () => {
  const ledger = buildLedger(
    [
      row(2, '2026-11-01', 'Rent', 500, 'Bills', 'a'),
      row(3, '2026-11-01', 'Rent', 450, 'Bills', 'a'),
      row(4, '2026-11-01', 'Rent', 500, 'Bills', 'a'),
    ],
    2,
  );
  expect(ledger.expenses).toEqual([]);
  expect(ledger.issues.map((i) => [i.rowNumber, i.kind])).toEqual([
    [2, 'conflicting_duplicate'],
    [3, 'conflicting_duplicate'],
    [4, 'conflicting_duplicate'],
  ]);
  expect(affectsTotals('conflicting_duplicate')).toBe(true);
});
