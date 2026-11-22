import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openTestDatabase, type TestDatabase } from '../../test/sqliteTestDatabase';

import { parseLocalDate, periodRange, type LocalDate } from '@/domain/dates';
import type { DataScope } from '@/domain/expense';

import { dataScopeOf, getAppSettings } from './appSettings';
import { insertConfirmedExpense, listConfirmedExpenses } from './confirmedExpenses';
import { migrateDatabase } from './migrations';
import {
  getPendingSubmission,
  insertPendingSubmission,
  listPendingSubmissions,
  type NewPendingSubmission,
} from './pendingSubmissions';

const d = (value: string): LocalDate => {
  const date = parseLocalDate(value);
  if (date === null) throw new Error(`bad fixture ${value}`);
  return date;
};

const scope: DataScope = { accountId: 'google-sub-123', spreadsheetId: 'sheet-abc' };
const otherScope: DataScope = { accountId: 'google-sub-999', spreadsheetId: 'sheet-xyz' };

const submission = (overrides: Partial<NewPendingSubmission> = {}): NewPendingSubmission => ({
  submissionId: 'b3f1c2d4-0000-4000-8000-000000000001',
  createdAt: '2026-11-22T03:04:05.678Z',
  purchaseDate: d('2026-11-22'),
  description: 'Groceries at the market',
  amountMinor: 4_235,
  category: 'Groceries',
  ...overrides,
});

let t: TestDatabase;

beforeEach(async () => {
  t = openTestDatabase();
  await migrateDatabase(t.db);
});

afterEach(() => {
  t.close();
});

describe('pending submissions', () => {
  test('insert and read back with initial state', async () => {
    await insertPendingSubmission(t.db, scope, submission());

    expect(await getPendingSubmission(t.db, 'b3f1c2d4-0000-4000-8000-000000000001')).toEqual({
      submissionId: 'b3f1c2d4-0000-4000-8000-000000000001',
      accountId: 'google-sub-123',
      spreadsheetId: 'sheet-abc',
      purchaseDate: '2026-11-22',
      description: 'Groceries at the market',
      amountMinor: 4_235,
      category: 'Groceries',
      state: 'pending',
      createdAt: '2026-11-22T03:04:05.678Z',
      lastAttemptAt: null,
      attemptCount: 0,
      lastError: null,
    });
    expect(await getPendingSubmission(t.db, 'missing')).toBeNull();
  });

  test('listing is scoped to one account + spreadsheet and ordered oldest first', async () => {
    await insertPendingSubmission(t.db, scope, submission({ submissionId: 's2', createdAt: '2026-11-22T05:00:00.000Z' }));
    await insertPendingSubmission(t.db, scope, submission({ submissionId: 's1', createdAt: '2026-11-22T04:00:00.000Z' }));
    await insertPendingSubmission(t.db, otherScope, submission({ submissionId: 'other' }));

    expect((await listPendingSubmissions(t.db, scope)).map((s) => s.submissionId)).toEqual(['s1', 's2']);
    expect((await listPendingSubmissions(t.db, otherScope)).map((s) => s.submissionId)).toEqual(['other']);
  });

  test('submission IDs are unique', async () => {
    await insertPendingSubmission(t.db, scope, submission());
    await expect(insertPendingSubmission(t.db, scope, submission())).rejects.toThrow(/UNIQUE/);
  });

  test('the expense payload is immutable once stored', async () => {
    await insertPendingSubmission(t.db, scope, submission());
    const id = submission().submissionId;

    for (const [column, value] of [
      ['description', 'Changed'],
      ['amount_minor', 1],
      ['category', 'Other'],
      ['purchase_date', '2026-11-01'],
      ['account_id', 'someone-else'],
      ['spreadsheet_id', 'other-sheet'],
      ['created_at', '2026-01-01T00:00:00.000Z'],
    ] as const) {
      expect(() =>
        t.raw.prepare(`UPDATE pending_submissions SET ${column} = ? WHERE submission_id = ?`).run(value, id),
      ).toThrow('pending submission payload is immutable');
    }
    expect((await getPendingSubmission(t.db, id))?.description).toBe('Groceries at the market');
  });

  test('delivery bookkeeping columns can change', async () => {
    await insertPendingSubmission(t.db, scope, submission());
    const id = submission().submissionId;
    t.raw
      .prepare(
        `UPDATE pending_submissions
         SET state = 'blocked', attempt_count = 3, last_attempt_at = ?,
             last_error_code = 'sheet_missing', last_error_http_status = 404
         WHERE submission_id = ?`,
      )
      .run('2026-11-22T06:00:00.000Z', id);

    expect(await getPendingSubmission(t.db, id)).toMatchObject({
      state: 'blocked',
      attemptCount: 3,
      lastAttemptAt: '2026-11-22T06:00:00.000Z',
      lastError: { code: 'sheet_missing', httpStatus: 404 },
    });
  });

  test('SQL metacharacters in user text are stored verbatim (bound parameters)', async () => {
    const hostile = `Bob's "shop"; DROP TABLE pending_submissions; --`;
    await insertPendingSubmission(t.db, scope, submission({ description: hostile }));
    expect((await getPendingSubmission(t.db, submission().submissionId))?.description).toBe(hostile);
  });

  test('rejects invalid payloads before they reach SQLite', async () => {
    await expect(insertPendingSubmission(t.db, scope, submission({ amountMinor: 0 }))).rejects.toThrow();
    await expect(insertPendingSubmission(t.db, scope, submission({ amountMinor: 12.5 }))).rejects.toThrow();
    await expect(insertPendingSubmission(t.db, scope, submission({ category: ' ' }))).rejects.toThrow();
    await expect(
      insertPendingSubmission(t.db, scope, submission({ purchaseDate: '2026-02-30' as LocalDate })),
    ).rejects.toThrow();
    await expect(
      insertPendingSubmission(t.db, { accountId: '', spreadsheetId: 'x' }, submission()),
    ).rejects.toThrow();
  });
});

describe('database constraints (defence in depth)', () => {
  const insertRaw = (values: Record<string, unknown>) =>
    t.raw
      .prepare(
        `INSERT INTO confirmed_expenses
           (expense_id, account_id, spreadsheet_id, purchase_date, description, amount_minor, category)
         VALUES (@expense_id, @account_id, @spreadsheet_id, @purchase_date, @description, @amount_minor, @category)`,
      )
      .run({
        expense_id: 'e1',
        account_id: 'a',
        spreadsheet_id: 's',
        purchase_date: '2026-11-22',
        description: 'x',
        amount_minor: 100,
        category: 'Other',
        ...values,
      });

  test('accepts a valid row', () => {
    expect(() => insertRaw({})).not.toThrow();
  });

  test.each([
    ['zero amount', { amount_minor: 0 }],
    ['negative amount', { amount_minor: -5 }],
    ['fractional amount (STRICT INTEGER)', { amount_minor: 12.5 }],
    // STRICT coerces lossless text such as '12' to INTEGER 12; anything else fails.
    ['non-numeric amount (STRICT INTEGER)', { amount_minor: 'twelve' }],
    ['decimal text amount (STRICT INTEGER)', { amount_minor: '12.5' }],
    ['impossible date', { purchase_date: '2026-02-30' }],
    ['out-of-range month', { purchase_date: '2026-13-01' }],
    ['date with time', { purchase_date: '2026-11-22 10:00:00' }],
    ['unpadded date', { purchase_date: '2026-1-5' }],
    ['empty account', { account_id: '' }],
    ['missing spreadsheet', { spreadsheet_id: null }],
  ])('rejects %s', (_label, values) => {
    expect(() => insertRaw(values)).toThrow();
  });

  test('pending state, timestamps and error codes are constrained', async () => {
    await insertPendingSubmission(t.db, scope, submission());
    const id = submission().submissionId;
    const update = (sql: string, ...params: unknown[]) => () => t.raw.prepare(sql).run(...params, id);

    expect(update("UPDATE pending_submissions SET state = 'done' WHERE submission_id = ?")).toThrow();
    expect(update('UPDATE pending_submissions SET attempt_count = -1 WHERE submission_id = ?')).toThrow();
    expect(update("UPDATE pending_submissions SET last_attempt_at = '22/11/2026' WHERE submission_id = ?")).toThrow();
    expect(update("UPDATE pending_submissions SET last_error_code = 'Network failed for bob@example.com' WHERE submission_id = ?")).toThrow();
    expect(update('UPDATE pending_submissions SET last_error_http_status = 42 WHERE submission_id = ?')).toThrow();
  });

  test('settings stay a single row and a spreadsheet needs an account', () => {
    expect(() => t.raw.prepare("INSERT INTO app_settings (id, schema_version, currency_code, currency_minor_units) VALUES (2, 1, 'AUD', 2)").run()).toThrow();
    expect(() => t.raw.prepare("UPDATE app_settings SET spreadsheet_id = 'sheet' WHERE id = 1").run()).toThrow();
    expect(() => t.raw.prepare("UPDATE app_settings SET currency_code = 'aud' WHERE id = 1").run()).toThrow();
    expect(() => t.raw.prepare('UPDATE app_settings SET currency_minor_units = 7 WHERE id = 1').run()).toThrow();
  });
});

describe('confirmed expenses', () => {
  const expense = (id: string, date: string, amountMinor = 1_000) => ({
    expenseId: id,
    purchaseDate: d(date),
    description: `Item ${id}`,
    amountMinor,
    category: 'Shopping',
  });

  beforeEach(async () => {
    for (const [id, date] of [
      ['oct31', '2026-10-31'],
      ['nov01', '2026-11-01'],
      ['nov30', '2026-11-30'],
      ['dec01', '2026-12-01'],
      ['leap', '2024-02-29'],
    ] as const) {
      await insertConfirmedExpense(t.db, scope, expense(id, date));
    }
    await insertConfirmedExpense(t.db, otherScope, expense('foreign', '2026-11-15'));
  });

  test('month filter uses half-open boundaries', async () => {
    const rows = await listConfirmedExpenses(t.db, scope, periodRange({ kind: 'month', year: 2026, month: 11 }));
    expect(rows.map((r) => r.expenseId)).toEqual(['nov01', 'nov30']);
  });

  test('day, year and all-time filters', async () => {
    const day = await listConfirmedExpenses(t.db, scope, periodRange({ kind: 'day', date: d('2024-02-29') }));
    const year = await listConfirmedExpenses(t.db, scope, periodRange({ kind: 'year', year: 2026 }));
    const all = await listConfirmedExpenses(t.db, scope, null);

    expect(day.map((r) => r.expenseId)).toEqual(['leap']);
    expect(year.map((r) => r.expenseId)).toEqual(['oct31', 'nov01', 'nov30', 'dec01']);
    expect(all.map((r) => r.expenseId)).toEqual(['leap', 'oct31', 'nov01', 'nov30', 'dec01']);
  });

  test('never returns rows from another account or spreadsheet', async () => {
    const all = await listConfirmedExpenses(t.db, scope, null);
    expect(all.map((r) => r.expenseId)).not.toContain('foreign');
    expect((await listConfirmedExpenses(t.db, otherScope, null)).map((r) => r.expenseId)).toEqual(['foreign']);
  });
});

describe('app settings', () => {
  test('dataScopeOf is null until account and spreadsheet are both set', async () => {
    expect(dataScopeOf(await getAppSettings(t.db))).toBeNull();
    t.raw.prepare("UPDATE app_settings SET google_account_id = 'sub-1' WHERE id = 1").run();
    expect(dataScopeOf(await getAppSettings(t.db))).toBeNull();
    t.raw.prepare("UPDATE app_settings SET spreadsheet_id = 'sheet-1', expenses_sheet_id = 0 WHERE id = 1").run();
    expect(dataScopeOf(await getAppSettings(t.db))).toEqual({ accountId: 'sub-1', spreadsheetId: 'sheet-1' });
  });
});

describe('restart', () => {
  test('pending and confirmed rows and settings survive reopening the file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-db-'));
    try {
      const file = path.join(dir, 'expenses.db');
      const first = openTestDatabase(file);
      await migrateDatabase(first.db);
      first.raw
        .prepare("UPDATE app_settings SET google_account_id = ?, spreadsheet_id = ?, expenses_sheet_id = ? WHERE id = 1")
        .run(scope.accountId, scope.spreadsheetId, 123);
      await insertPendingSubmission(first.db, scope, submission());
      await insertConfirmedExpense(first.db, scope, {
        expenseId: 'confirmed-1',
        purchaseDate: d('2026-11-20'),
        description: 'Bus fare',
        amountMinor: 380,
        category: 'Transport',
      });
      first.close();

      const second = openTestDatabase(file);
      await migrateDatabase(second.db);
      const settings = await getAppSettings(second.db);
      expect(dataScopeOf(settings)).toEqual(scope);
      expect(settings.expensesSheetId).toBe(123);
      expect((await listPendingSubmissions(second.db, scope)).map((s) => s.submissionId)).toEqual([
        submission().submissionId,
      ]);
      expect(await listConfirmedExpenses(second.db, scope, null)).toEqual([
        { expenseId: 'confirmed-1', purchaseDate: '2026-11-20', description: 'Bus fare', amountMinor: 380, category: 'Transport' },
      ]);
      second.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
