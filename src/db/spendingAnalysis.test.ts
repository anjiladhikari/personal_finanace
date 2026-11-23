import { openTestDatabase, type TestDatabase } from '../../test/sqliteTestDatabase';

import { parseLocalDate, type LocalDate, type Period } from '@/domain/dates';
import type { DataScope } from '@/domain/expense';

import { insertConfirmedExpense } from './confirmedExpenses';
import { migrateDatabase } from './migrations';
import { insertPendingSubmission } from './pendingSubmissions';
import { analyzeSpending } from './spendingAnalysis';

const scope: DataScope = { accountId: 'acct', spreadsheetId: 'sheet' };
const other: DataScope = { accountId: 'other', spreadsheetId: 'sheet-2' };
const d = (value: string) => parseLocalDate(value) as LocalDate;

let t: TestDatabase;
let n = 0;

async function add(date: string, amountMinor: number, category: string, where: DataScope = scope) {
  n += 1;
  await insertConfirmedExpense(t.db, where, {
    expenseId: `e${n}`,
    purchaseDate: d(date),
    description: 'x',
    amountMinor,
    category,
  });
}

beforeEach(async () => {
  t = openTestDatabase();
  await migrateDatabase(t.db);
  n = 0;
});

afterEach(() => t.close());

describe('period boundaries use purchase_date, half-open', () => {
  beforeEach(async () => {
    await add('2024-02-28', 100, 'Groceries');
    await add('2024-02-29', 200, 'Groceries'); // leap day
    await add('2024-03-01', 400, 'Groceries');
    await add('2025-12-31', 800, 'Bills');
    await add('2026-01-01', 1_600, 'Bills');
    await add('2026-11-30', 3_200, 'Transport');
    await add('2026-12-01', 6_400, 'Transport');
  });

  test.each<[string, Period, number, string | null, string | null]>([
    ['leap day', { kind: 'day', date: d('2024-02-29') }, 200, '2024-02-29', '2024-03-01'],
    ['February 2024', { kind: 'month', year: 2024, month: 2 }, 300, '2024-02-01', '2024-03-01'],
    ['March 2024', { kind: 'month', year: 2024, month: 3 }, 400, '2024-03-01', '2024-04-01'],
    ['December 2025 (year end)', { kind: 'month', year: 2025, month: 12 }, 800, '2025-12-01', '2026-01-01'],
    ['year 2025', { kind: 'year', year: 2025 }, 800, '2025-01-01', '2026-01-01'],
    ['year 2026', { kind: 'year', year: 2026 }, 11_200, '2026-01-01', '2027-01-01'],
    ['November 2026 (last day included)', { kind: 'month', year: 2026, month: 11 }, 3_200, '2026-11-01', '2026-12-01'],
    ['all time', { kind: 'all' }, 12_700, null, null],
  ])('%s', async (_label, period, total, start, endExclusive) => {
    const analysis = await analyzeSpending(t.db, scope, period);
    expect(analysis).toMatchObject({ period, totalMinor: total, start, endExclusive });
  });
});

test('an empty period returns zero and no categories', async () => {
  await add('2026-11-30', 3_200, 'Transport');
  expect(await analyzeSpending(t.db, scope, { kind: 'month', year: 2026, month: 10 })).toEqual({
    period: { kind: 'month', year: 2026, month: 10 },
    start: '2026-10-01',
    endExclusive: '2026-11-01',
    totalMinor: 0,
    categories: [],
    lastSuccessfulSyncAt: null,
    excludedRowCount: 0,
  });
});

test('sums integer minor units exactly and ranks categories deterministically', async () => {
  for (let i = 0; i < 10; i += 1) await add('2026-11-05', 10, 'Eating out'); // 10 × $0.10
  await add('2026-11-06', 100, 'Transport');
  await add('2026-11-07', 30, 'Bills');
  await add('2026-11-07', 70, 'Bills');

  const analysis = await analyzeSpending(t.db, scope, { kind: 'month', year: 2026, month: 11 });

  expect(analysis.totalMinor).toBe(300);
  expect(analysis.categories).toEqual([
    { category: 'Bills', amountMinor: 100, percentBasisPoints: 3_334, percentage: 33.34 },
    { category: 'Eating out', amountMinor: 100, percentBasisPoints: 3_333, percentage: 33.33 },
    { category: 'Transport', amountMinor: 100, percentBasisPoints: 3_333, percentage: 33.33 },
  ]);
});

test('only confirmed expenses of this account and spreadsheet are counted', async () => {
  await add('2026-11-05', 1_000, 'Bills');
  await add('2026-11-05', 9_999, 'Bills', other);
  await insertPendingSubmission(t.db, scope, {
    submissionId: 'p1',
    createdAt: '2026-11-05T00:00:00.000Z',
    purchaseDate: d('2026-11-05'),
    description: 'pending',
    amountMinor: 5_000,
    category: 'Bills',
  });

  expect((await analyzeSpending(t.db, scope, { kind: 'all' })).totalMinor).toBe(1_000);
});

test('reports the last successful sync time and rows excluded by the last refresh', async () => {
  t.raw.prepare("UPDATE app_settings SET last_successful_sync_at = '2026-11-22T03:00:00.000Z' WHERE id = 1").run();
  t.raw
    .prepare(
      `INSERT INTO sheet_issues (account_id, spreadsheet_id, row_number, kind, expense_id) VALUES
       ('acct', 'sheet', 5, 'invalid_amount', 'x'), ('acct', 'sheet', 6, 'duplicate_resolved', 'y'),
       ('other', 'sheet-2', 7, 'missing_id', NULL)`,
    )
    .run();

  expect(await analyzeSpending(t.db, scope, { kind: 'all' })).toMatchObject({
    lastSuccessfulSyncAt: '2026-11-22T03:00:00.000Z',
    excludedRowCount: 1,
  });
});
