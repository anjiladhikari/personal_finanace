import { openTestDatabase, type TestDatabase } from '../../test/sqliteTestDatabase';

import { parseLocalDate, type LocalDate } from '@/domain/dates';
import type { DataScope } from '@/domain/expense';

import {
  categoryUsage,
  DuplicateCategoryError,
  insertCustomCategory,
  listCustomCategories,
  listExpenseCategoryLabels,
  mergeRemoteCategories,
} from './categories';
import { insertConfirmedExpense } from './confirmedExpenses';
import { migrateDatabase } from './migrations';
import { insertPendingSubmission } from './pendingSubmissions';

const scope: DataScope = { accountId: 'acct', spreadsheetId: 'sheet' };
const other: DataScope = { accountId: 'other', spreadsheetId: 'sheet-2' };
const d = (value: string) => parseLocalDate(value) as LocalDate;
const FROM = d('2026-08-28');
const TO = d('2026-11-25');

let t: TestDatabase;

beforeEach(async () => {
  t = openTestDatabase();
  await migrateDatabase(t.db);
  t.raw.prepare("UPDATE app_settings SET google_account_id = 'acct' WHERE id = 1").run();
});

afterEach(() => t.close());

async function confirmed(id: string, date: string, category: string, where = scope) {
  await insertConfirmedExpense(t.db, where, { expenseId: id, purchaseDate: d(date), description: 'x', amountMinor: 100, category });
}

async function pending(id: string, date: string, category: string, where = scope) {
  await insertPendingSubmission(t.db, where, {
    submissionId: id,
    createdAt: '2026-11-25T00:00:00.000Z',
    purchaseDate: d(date),
    description: 'x',
    amountMinor: 100,
    category,
  });
}

describe('categoryUsage', () => {
  test('counts expenses, not amounts, over the last 90 days, including ones waiting to be sent', async () => {
    await confirmed('a', '2026-11-20', 'Fuel');
    await confirmed('b', '2026-11-21', 'Fuel');
    await pending('c', '2026-11-25', 'Kids');
    await confirmed('d', '2026-08-28', 'Pets'); // first day of the window
    await confirmed('e', '2026-08-27', 'Pets'); // the day before: excluded
    await confirmed('f', '2026-11-26', 'Pets'); // future-dated: excluded

    const usage = await categoryUsage(t.db, scope, FROM, TO);
    expect([...usage].sort((x, y) => x.category.localeCompare(y.category))).toEqual([
      { category: 'Fuel', count: 2 },
      { category: 'Kids', count: 1 },
      { category: 'Pets', count: 1 },
    ]);
  });

  test('an expense both waiting and already confirmed (same ID) is counted once', async () => {
    await confirmed('same-id', '2026-11-20', 'Fuel');
    await pending('same-id', '2026-11-20', 'Fuel');
    await pending('only-pending', '2026-11-20', 'Fuel');

    expect(await categoryUsage(t.db, scope, FROM, TO)).toEqual([{ category: 'Fuel', count: 2 }]);
  });

  test('only this account and spreadsheet', async () => {
    await confirmed('a', '2026-11-20', 'Fuel', other);
    expect(await categoryUsage(t.db, scope, FROM, TO)).toEqual([]);
  });
});

test('every label used by an expense, confirmed or waiting, exactly as written', async () => {
  await confirmed('a', '2026-01-01', 'Typed in Sheets');
  await confirmed('b', '2026-01-01', 'groceries');
  await pending('c', '2026-01-01', 'Kids');
  await confirmed('d', '2026-01-01', 'Elsewhere', other);
  expect(await listExpenseCategoryLabels(t.db, scope)).toEqual(['Kids', 'Typed in Sheets', 'groceries']);
});

describe('custom categories', () => {
  const kids = { id: 'c1', name: 'Kids', icon: 'tag', colour: 'red' as const, createdAt: '2026-11-25T00:00:00.000Z' };

  test('are refused twice for one account, ignoring case and spacing; other accounts are separate', async () => {
    await insertCustomCategory(t.db, 'acct', kids);
    await expect(insertCustomCategory(t.db, 'acct', { ...kids, id: 'c2', name: 'KIDS' })).rejects.toBeInstanceOf(DuplicateCategoryError);
    await insertCustomCategory(t.db, 'other', { ...kids, id: 'c3' });
    expect((await listCustomCategories(t.db, 'acct')).map((c) => c.id)).toEqual(['c1']);
  });

  test('merging the sheet: marks known ones backed up, adds new ones, never removes local ones', async () => {
    await insertCustomCategory(t.db, 'acct', kids);
    await insertCustomCategory(t.db, 'acct', { ...kids, id: 'local-only', name: 'Offline addition' });

    const changed = await mergeRemoteCategories(
      t.db,
      scope,
      [
        { id: 'c1', name: 'Kids', icon: 'tag', colour: 'red' },
        { id: 'r2', name: 'From the sheet', icon: 'paw', colour: 'blue' },
        { id: 'r3', name: 'Groceries', icon: 'tag', colour: 'blue' },
      ],
      new Set(['groceries']),
      '2026-11-25T01:00:00.000Z',
    );

    expect(changed).toBe(2);
    expect((await listCustomCategories(t.db, 'acct')).map((c) => [c.id, c.name, c.syncedSpreadsheetId])).toEqual([
      ['c1', 'Kids', 'sheet'],
      ['local-only', 'Offline addition', null],
      ['r2', 'From the sheet', 'sheet'],
    ]);
  });
});
