import { FakeAuthorizer, FakeGoogle } from '../../test/fakeGoogle';
import { openTestDatabase, type TestDatabase } from '../../test/sqliteTestDatabase';

import { getAppSettings } from '@/db/appSettings';
import { listCustomCategories, listExpenseCategoryLabels } from '@/db/categories';
import { listConfirmedExpenses } from '@/db/confirmedExpenses';
import { migrateDatabase } from '@/db/migrations';
import { listPendingSubmissions } from '@/db/pendingSubmissions';
import { buildCategoryRegistry } from '@/domain/categories';
import type { DataScope } from '@/domain/expense';
import { APP_PROPERTY_CATEGORIES_TAB_ID, CATEGORY_COLUMNS } from '@/domain/sheetContract';

import { syncCategories } from './categorySync';
import { connectGoogle } from './connection';
import { SubmissionEngine, type SubmissionDeps } from './submissions';

const ALICE = 'sub-alice';
const T0 = Date.parse('2026-11-25T03:00:00Z');

let google: FakeGoogle;
let authorizer: FakeAuthorizer;
let phone: TestDatabase;
let scope: DataScope;
let online: boolean;
let ids: number;

function deps(db = phone.db): SubmissionDeps {
  return {
    db,
    authorizer,
    fetch: google.fetch,
    isOnline: async () => online,
    newId: () => `id-${(ids += 1)}`,
    now: () => T0,
  };
}

async function registry(db = phone.db) {
  return buildCategoryRegistry(await listCustomCategories(db, scope.accountId), await listExpenseCategoryLabels(db, scope));
}

/** The Categories tab of the spreadsheet, if it exists. */
function categoriesTab() {
  const file = google.files.get(scope.spreadsheetId);
  const id = file?.appProperties[APP_PROPERTY_CATEGORIES_TAB_ID];
  return file?.tabs.find((t) => String(t.sheetId) === id);
}

const definitionRows = () => (categoriesTab()?.rows ?? []).slice(1);

beforeEach(async () => {
  google = new FakeGoogle();
  google.addAccount(ALICE, 'alice@example.com');
  authorizer = new FakeAuthorizer(google, [ALICE]);
  phone = openTestDatabase();
  await migrateDatabase(phone.db);
  const state = await connectGoogle({ db: phone.db, authorizer, fetch: google.fetch }, { interactive: true });
  if (state.kind !== 'ready') throw new Error('setup failed');
  scope = { accountId: ALICE, spreadsheetId: state.spreadsheetId };
  online = true;
  ids = 0;
  google.log.length = 0;
});

afterEach(() => {
  phone.close();
});

describe('creating a category', () => {
  test('offline: saved on the phone at once and usable; nothing is sent', async () => {
    online = false;
    const engine = new SubmissionEngine(deps());

    const outcome = await engine.createCategory('  Kids’   swimming ', await registry());

    expect(outcome).toMatchObject({ kind: 'created', category: { name: 'Kids’ swimming', icon: 'tag', source: 'custom' } });
    expect(await listCustomCategories(phone.db, scope.accountId)).toEqual([
      expect.objectContaining({ id: 'custom-id-1', name: 'Kids’ swimming', syncedSpreadsheetId: null }),
    ]);
    expect((await registry()).isSelectable('Kids’ swimming')).toBe(true);
    expect(google.log).toEqual([]);

    // Saving an expense with it works offline too (it waits like any other save).
    await engine.submit({ purchaseDate: '2026-11-25' as never, description: 'Lessons', amountMinor: 2_500, category: 'Kids’ swimming' });
    expect(await listPendingSubmissions(phone.db, scope)).toEqual([expect.objectContaining({ category: 'Kids’ swimming' })]);
  });

  test('never saves an expense', async () => {
    const engine = new SubmissionEngine(deps());
    await engine.createCategory('Kids', await registry());
    await engine.syncCategories();
    expect(google.yearRows(scope.spreadsheetId, '2026')).toEqual([]);
    expect(await listPendingSubmissions(phone.db, scope)).toEqual([]);
  });

  test('duplicates are refused, ignoring case and spacing, across built-in and custom categories', async () => {
    const engine = new SubmissionEngine(deps());
    expect(await engine.createCategory(' groceries ', await registry())).toMatchObject({ kind: 'duplicate', existing: { name: 'Groceries' } });
    await engine.createCategory('Kids', await registry());
    expect(await engine.createCategory('KIDS', await registry())).toMatchObject({ kind: 'duplicate', existing: { name: 'Kids' } });
    // Even with a stale view, the database refuses a second definition of one name.
    expect(await engine.createCategory('kids', buildCategoryRegistry([], []))).toMatchObject({ kind: 'duplicate' });
    expect(await engine.createCategory('   ', await registry())).toEqual({ kind: 'invalid', error: 'blank' });
    expect(await listCustomCategories(phone.db, scope.accountId)).toHaveLength(1);
  });

  test('survives a restart', async () => {
    online = false;
    await new SubmissionEngine(deps()).createCategory('Kids', await registry());
    // A new engine over the same database file is what the app sees after a restart.
    const restarted = new SubmissionEngine(deps());
    expect((await registry()).find('kids')).toMatchObject({ name: 'Kids', source: 'custom' });
    online = true;
    await restarted.processQueue('startup');
    expect(definitionRows()).toEqual([['custom-id-1', 'Kids', 'tag', expect.any(String), new Date(T0).toISOString()]]);
  });
});

describe('backing up definitions', () => {
  test('back online: the Categories tab is created once, with its header, and the definition appended as literal text', async () => {
    online = false;
    const engine = new SubmissionEngine(deps());
    await engine.createCategory('=SUM(1,2)', await registry());

    online = true;
    await engine.processQueue('connectivity');

    const tab = categoriesTab();
    expect(tab?.title).toBe('Categories');
    expect(tab?.rows[0]).toEqual([...CATEGORY_COLUMNS]);
    expect(definitionRows()).toEqual([['custom-id-1', '=SUM(1,2)', 'tag', expect.any(String), expect.any(String)]]);
    expect(google.requests('POST', ':append')[0]?.path).toBeDefined();
    expect(google.log.some((r) => r.method === 'POST' && r.path.includes(':append'))).toBe(true);
    expect(await listCustomCategories(phone.db, scope.accountId)).toEqual([
      expect.objectContaining({ syncedSpreadsheetId: scope.spreadsheetId }),
    ]);
    // The Expenses tab and its rows are untouched.
    expect(google.yearRows(scope.spreadsheetId, '2026')).toEqual([]);
  });

  test('a lost response after the write is retried without a second row', async () => {
    const engine = new SubmissionEngine(deps());
    google.failNext({ method: 'POST', pathIncludes: ':append', response: 'network_after_commit' });

    // Creating starts a backup at once; its append lands but the reply is lost.
    await engine.createCategory('Kids', await registry());
    // The retry reads the tab first, finds the ID and does not append again.
    await engine.syncCategories();
    await engine.syncCategories();

    expect(google.requests('POST', ':append')).toHaveLength(1);
    expect(definitionRows()).toHaveLength(1);
    expect(await listCustomCategories(phone.db, scope.accountId)).toEqual([expect.objectContaining({ syncedSpreadsheetId: scope.spreadsheetId })]);
  });

  test('no Categories tab is added to the spreadsheet until there is a category to back up', async () => {
    const engine = new SubmissionEngine(deps());
    await engine.syncCategories({ restore: true });
    await engine.processQueue('startup');
    expect(categoriesTab()).toBeUndefined();
    expect(google.requests('POST', ':batchUpdate')).toEqual([]);
  });

  test('a changed Categories header stops category backups but not expense saves', async () => {
    const engine = new SubmissionEngine(deps());
    await engine.createCategory('Kids', await registry());
    await engine.syncCategories();
    const tabId = categoriesTab()?.sheetId ?? -1;
    google.userEdit(scope.spreadsheetId, (rows) => {
      rows[0] = ['Something else'];
    }, tabId);

    await engine.createCategory('Pets & vet', await registry());
    expect(await syncCategories(deps(), { force: false })).toEqual({ kind: 'failed', code: 'categories_tab_changed' });
    expect(definitionRows()).toHaveLength(1);

    expect(await engine.submit({ purchaseDate: '2026-11-25' as never, description: 'Vet', amountMinor: 9_000, category: 'Pets & vet' })).toMatchObject({
      kind: 'confirmed',
    });
  });
});

describe('restoring definitions', () => {
  async function anotherInstall() {
    const fresh = openTestDatabase();
    await migrateDatabase(fresh.db);
    const state = await connectGoogle({ db: fresh.db, authorizer, fetch: google.fetch }, { interactive: true });
    if (state.kind !== 'ready') throw new Error('reconnect failed');
    return fresh;
  }

  test('after a reinstall, categories that were backed up come back, without new rows', async () => {
    const engine = new SubmissionEngine(deps());
    await engine.createCategory('Kids', await registry());
    await engine.createCategory('Dog walking', await registry());
    await engine.syncCategories();
    const before = definitionRows();

    const reinstalled = await anotherInstall();
    await new SubmissionEngine(deps(reinstalled.db)).syncCategories({ restore: true });

    expect((await listCustomCategories(reinstalled.db, scope.accountId)).map((c) => [c.id, c.name, c.syncedSpreadsheetId])).toEqual([
      ['custom-id-1', 'Kids', scope.spreadsheetId],
      ['custom-id-2', 'Dog walking', scope.spreadsheetId],
    ]);
    expect((await registry(reinstalled.db)).find('Dog walking')?.colour).toBe((await registry()).find('Dog walking')?.colour);
    expect(definitionRows()).toEqual(before);
    expect((await getAppSettings(reinstalled.db)).categoriesMergedSpreadsheetId).toBe(scope.spreadsheetId);
    reinstalled.close();
  });

  test('a category created offline on the new install before restoring merges into the saved one', async () => {
    const engine = new SubmissionEngine(deps());
    await engine.createCategory('Kids', await registry());
    await engine.syncCategories();

    const reinstalled = await anotherInstall();
    online = false;
    const newEngine = new SubmissionEngine({ ...deps(reinstalled.db), newId: () => 'new-device' });
    await newEngine.createCategory('kids', await registry(reinstalled.db));
    online = true;
    await newEngine.syncCategories({ restore: true });

    expect((await listCustomCategories(reinstalled.db, scope.accountId)).map((c) => c.id)).toEqual(['custom-id-1']);
    expect(definitionRows()).toHaveLength(1);
    reinstalled.close();
  });

  test('definitions in the tab that clash with a built-in or are unusable are ignored', async () => {
    const engine = new SubmissionEngine(deps());
    await engine.createCategory('Kids', await registry());
    await engine.syncCategories();
    google.userEdit(
      scope.spreadsheetId,
      (rows) => {
        rows.push(['x1', 'GROCERIES', 'tag', 'red', ''], ['', 'No ID', 'tag', 'red', ''], ['x3', 'Hand-made', 'unknown-icon', 'purple', '']);
      },
      categoriesTab()?.sheetId ?? -1,
    );

    await engine.syncCategories({ restore: true });

    const names = (await listCustomCategories(phone.db, scope.accountId)).map((c) => c.name);
    expect(names).toEqual(['Kids', 'Hand-made']);
    expect((await registry()).find('Hand-made')).toMatchObject({ icon: 'tag' });
  });
});

describe('refresh', () => {
  test('keeps categories created offline, and backs them up', async () => {
    online = false;
    const engine = new SubmissionEngine(deps());
    await engine.createCategory('Kids', await registry());

    online = true;
    expect(await engine.refresh()).toMatchObject({ kind: 'refreshed' });

    expect(await listCustomCategories(phone.db, scope.accountId)).toEqual([
      expect.objectContaining({ name: 'Kids', syncedSpreadsheetId: scope.spreadsheetId }),
    ]);
    expect(definitionRows()).toHaveLength(1);
  });

  test('labels in expense rows are kept exactly, even with no definition', async () => {
    google.seedExpenseRows(scope.spreadsheetId, [
      ['2026-11-20', 'Hand typed', 12, 'Typed in Sheets', 'h1'],
      ['2026-11-21', 'Lowercase', 3, 'groceries', 'h2'],
    ]);
    const engine = new SubmissionEngine(deps());
    await engine.refresh();

    expect((await listConfirmedExpenses(phone.db, scope, null)).map((e) => e.category).sort()).toEqual(['Typed in Sheets', 'groceries']);
    const current = await registry();
    expect(current.find('Typed in Sheets')).toMatchObject({ name: 'Typed in Sheets', source: 'history' });
    expect(current.isSelectable('Typed in Sheets')).toBe(true);
    // "groceries" is the built-in Groceries for colour and search, but the row keeps its text.
    expect(current.find('groceries')?.name).toBe('Groceries');
    expect(await listCustomCategories(phone.db, scope.accountId)).toEqual([]);
  });
});
