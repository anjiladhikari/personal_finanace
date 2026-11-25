import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openTestDatabase, type TestDatabase } from '../../test/sqliteTestDatabase';

import { DiagnosticError } from '@/diagnostics/log';

import { getAppSettings } from './appSettings';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, migrateDatabase, readSchemaVersion, type Migration } from './migrations';

let testDb: TestDatabase;

beforeEach(() => {
  testDb = openTestDatabase();
});

afterEach(() => {
  testDb.close();
});

function tableNames(t: TestDatabase): string[] {
  return (
    t.raw
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((row) => row.name);
}

describe('migrateDatabase', () => {
  test('creates the schema on a fresh database', async () => {
    const result = await migrateDatabase(testDb.db);

    expect(result).toEqual({ fromVersion: 0, toVersion: LATEST_SCHEMA_VERSION, applied: MIGRATIONS.length });
    expect(await readSchemaVersion(testDb.db)).toBe(LATEST_SCHEMA_VERSION);
    expect(tableNames(testDb)).toEqual([
      'app_settings',
      'categories',
      'confirmed_expenses',
      'confirmed_expenses_scope_date',
      'pending_submissions',
      'pending_submissions_payload_immutable',
      'pending_submissions_scope_date',
      'pending_submissions_spreadsheet_same_account',
      'pending_submissions_state',
      'pending_tab_sorts',
      'sheet_issues',
    ]);
  });

  test('seeds settings with the provisional currency and no Google binding', async () => {
    await migrateDatabase(testDb.db);
    expect(await getAppSettings(testDb.db)).toEqual({
      schemaVersion: LATEST_SCHEMA_VERSION,
      currency: { code: 'AUD', minorUnits: 2 },
      googleAccountId: null,
      googleAccountEmail: null,
      spreadsheetId: null,
      expensesSheetId: null,
      lastSuccessfulSyncAt: null,
      lastConfirmedSaveAt: null,
      categoriesMergedSpreadsheetId: null,
    });
  });

  test('is safe to rerun: later runs apply nothing and keep data', async () => {
    await migrateDatabase(testDb.db);
    testDb.raw.prepare("UPDATE app_settings SET google_account_id = 'acct-1' WHERE id = 1").run();

    const second = await migrateDatabase(testDb.db);
    const third = await migrateDatabase(testDb.db);

    expect(second).toEqual({ fromVersion: LATEST_SCHEMA_VERSION, toVersion: LATEST_SCHEMA_VERSION, applied: 0 });
    expect(third.applied).toBe(0);
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM app_settings').get()).toEqual({ n: 1 });
    expect((await getAppSettings(testDb.db)).googleAccountId).toBe('acct-1');
  });

  test('re-applying the v1 statements directly is also harmless (IF NOT EXISTS / OR IGNORE)', async () => {
    await migrateDatabase(testDb.db);
    for (const statement of MIGRATIONS[0]?.statements ?? []) {
      await testDb.db.execScript(statement);
    }
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM app_settings').get()).toEqual({ n: 1 });
  });

  test('a failing migration rolls back completely, including user_version', async () => {
    const broken: Migration[] = [
      ...MIGRATIONS,
      {
        version: MIGRATIONS.length + 1,
        name: 'broken',
        statements: ['CREATE TABLE half_done (id INTEGER)', 'THIS IS NOT SQL'],
      },
    ];

    await expect(migrateDatabase(testDb.db, broken)).rejects.toThrow();

    expect(await readSchemaVersion(testDb.db)).toBe(LATEST_SCHEMA_VERSION);
    expect(tableNames(testDb)).not.toContain('half_done');
    expect((await getAppSettings(testDb.db)).schemaVersion).toBe(LATEST_SCHEMA_VERSION);

    // Once fixed, the next launch applies it.
    const fixed: Migration[] = [
      ...MIGRATIONS,
      { version: MIGRATIONS.length + 1, name: 'fixed', statements: ['CREATE TABLE half_done (id INTEGER)'] },
    ];
    expect((await migrateDatabase(testDb.db, fixed)).applied).toBe(1);
    expect(tableNames(testDb)).toContain('half_done');
  });

  test('refuses to touch a database from a newer app version', async () => {
    testDb.raw.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    const attempt = migrateDatabase(testDb.db);
    await expect(attempt).rejects.toBeInstanceOf(DiagnosticError);
    await expect(migrateDatabase(testDb.db)).rejects.toMatchObject({ code: 'database_newer_than_app' });
    expect(tableNames(testDb)).toEqual([]);
  });

  test('rejects gaps in the migration list', async () => {
    const gappy: Migration[] = [{ version: 2, name: 'gap', statements: [] }];
    await expect(migrateDatabase(testDb.db, gappy)).rejects.toThrow('without gaps');
  });
});

describe('persistence across restart', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-db-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('schema and rows survive closing and reopening the database file', async () => {
    const file = path.join(dir, 'expenses.db');

    const first = openTestDatabase(file);
    await migrateDatabase(first.db);
    first.raw
      .prepare(
        `INSERT INTO pending_submissions
           (submission_id, account_id, spreadsheet_id, purchase_date, description, amount_minor, category, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('sub-1', 'acct-1', 'sheet-1', '2026-11-22', 'Coffee', 450, 'Eating out', '2026-11-22T01:02:03.000Z');
    first.close();

    const second = openTestDatabase(file);
    const rerun = await migrateDatabase(second.db);
    expect(rerun.applied).toBe(0);
    expect(second.raw.prepare('SELECT submission_id, amount_minor FROM pending_submissions').all()).toEqual([
      { submission_id: 'sub-1', amount_minor: 450 },
    ]);
    second.close();
  });
});

describe('upgrading an existing v1 database', () => {
  test('v2 keeps existing rows and settings and adds the account email column', async () => {
    const v1Only = MIGRATIONS.filter((m) => m.version === 1);
    await migrateDatabase(testDb.db, v1Only);
    testDb.raw.prepare("UPDATE app_settings SET google_account_id = 'acct-1' WHERE id = 1").run();
    testDb.raw
      .prepare(
        `INSERT INTO pending_submissions
           (submission_id, account_id, spreadsheet_id, purchase_date, description, amount_minor, category, created_at)
         VALUES ('sub-1', 'acct-1', 'sheet-1', '2026-11-22', 'Coffee', 450, 'Eating out', '2026-11-22T01:02:03.000Z')`,
      )
      .run();

    const result = await migrateDatabase(testDb.db);

    expect(result).toEqual({ fromVersion: 1, toVersion: LATEST_SCHEMA_VERSION, applied: LATEST_SCHEMA_VERSION - 1 });
    expect(await getAppSettings(testDb.db)).toMatchObject({ googleAccountId: 'acct-1', googleAccountEmail: null });
    expect(testDb.raw.prepare('SELECT submission_id FROM pending_submissions').all()).toEqual([{ submission_id: 'sub-1' }]);
  });

  test('v4 keeps settings and adds an empty last confirmed save time', async () => {
    await migrateDatabase(
      testDb.db,
      MIGRATIONS.filter((m) => m.version <= 3),
    );
    testDb.raw.prepare("UPDATE app_settings SET last_successful_sync_at = '2026-11-20T09:30:00.000Z' WHERE id = 1").run();

    expect(
      await migrateDatabase(
        testDb.db,
        MIGRATIONS.filter((m) => m.version <= 4),
      ),
    ).toEqual({ fromVersion: 3, toVersion: 4, applied: 1 });
    expect(testDb.raw.prepare('SELECT last_successful_sync_at, last_confirmed_save_at FROM app_settings WHERE id = 1').get()).toEqual({
      last_successful_sync_at: '2026-11-20T09:30:00.000Z',
      last_confirmed_save_at: null,
    });
    expect(() => testDb.raw.prepare("UPDATE app_settings SET last_confirmed_save_at = '' WHERE id = 1").run()).toThrow();
  });

  test('v5 adds an empty categories table; existing expenses keep their category text', async () => {
    await migrateDatabase(
      testDb.db,
      MIGRATIONS.filter((m) => m.version <= 4),
    );
    testDb.raw
      .prepare(
        `INSERT INTO confirmed_expenses (expense_id, account_id, spreadsheet_id, purchase_date, description, amount_minor, category)
         VALUES ('e1', 'acct-1', 'sheet-1', '2026-11-01', 'Rent', 50000, 'Bills'), ('e2', 'acct-1', 'sheet-1', '2026-11-02', 'x', 100, 'Typed in sheet')`,
      )
      .run();

    expect(
      await migrateDatabase(
        testDb.db,
        MIGRATIONS.filter((m) => m.version <= 5),
      ),
    ).toEqual({ fromVersion: 4, toVersion: 5, applied: 1 });
    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM categories').get()).toEqual({ n: 0 });
    expect(testDb.raw.prepare('SELECT category FROM confirmed_expenses ORDER BY expense_id').all()).toEqual([
      { category: 'Bills' },
      { category: 'Typed in sheet' },
    ]);
    // Names are unique per account, ignoring case and spacing (via name_key).
    const insert = testDb.raw.prepare(
      `INSERT INTO categories (category_id, account_id, name, name_key, icon, colour, created_at) VALUES (?, 'acct-1', ?, ?, 'tag', 'blue', 'x')`,
    );
    insert.run('c1', 'Kids', 'kids');
    expect(() => insert.run('c2', 'KIDS', 'kids')).toThrow(/UNIQUE/);
    expect(() => insert.run('c3', 'x'.repeat(31), 'x'.repeat(31))).toThrow(/CHECK/);
  });

  test('v6 (yearly tabs) drops the cache built from the old Expenses tab; pending saves and categories stay', async () => {
    await migrateDatabase(
      testDb.db,
      MIGRATIONS.filter((m) => m.version <= 5),
    );
    testDb.raw.prepare("UPDATE app_settings SET google_account_id = 'acct-1', last_successful_sync_at = '2026-11-20T09:30:00.000Z' WHERE id = 1").run();
    testDb.raw
      .prepare(
        `INSERT INTO confirmed_expenses (expense_id, account_id, spreadsheet_id, purchase_date, description, amount_minor, category)
         VALUES ('old-test', 'acct-1', 'sheet-1', '2026-11-01', 'From the old worksheet', 500, 'Bills')`,
      )
      .run();
    testDb.raw
      .prepare(
        `INSERT INTO pending_submissions
           (submission_id, account_id, spreadsheet_id, purchase_date, description, amount_minor, category, created_at)
         VALUES ('waiting', 'acct-1', 'sheet-1', '2026-11-22', 'Coffee', 450, 'Eating out', '2026-11-22T01:02:03.000Z')`,
      )
      .run();
    testDb.raw
      .prepare(`INSERT INTO categories (category_id, account_id, name, name_key, icon, colour, created_at) VALUES ('c1', 'acct-1', 'Kids', 'kids', 'tag', 'red', 'x')`)
      .run();

    expect(await migrateDatabase(testDb.db)).toEqual({ fromVersion: 5, toVersion: LATEST_SCHEMA_VERSION, applied: 1 });

    expect(testDb.raw.prepare('SELECT COUNT(*) AS n FROM confirmed_expenses').get()).toEqual({ n: 0 });
    expect((await getAppSettings(testDb.db)).lastSuccessfulSyncAt).toBeNull();
    expect(testDb.raw.prepare('SELECT submission_id FROM pending_submissions').all()).toEqual([{ submission_id: 'waiting' }]);
    expect(testDb.raw.prepare('SELECT name FROM categories').all()).toEqual([{ name: 'Kids' }]);
    // Issues now name their yearly tab; the same row number may appear in two years.
    const issue = testDb.raw.prepare(
      `INSERT INTO sheet_issues (account_id, spreadsheet_id, tab_title, row_number, kind) VALUES ('acct-1', 'sheet-1', ?, 5, 'missing_id')`,
    );
    issue.run('2025');
    issue.run('2026');
    expect(() => issue.run('2026')).toThrow(/UNIQUE/);
  });
});
