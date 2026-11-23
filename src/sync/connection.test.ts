import { FakeAuthorizer, FakeGoogle } from '../../test/fakeGoogle';
import { openTestDatabase, type TestDatabase } from '../../test/sqliteTestDatabase';

import { getAppSettings } from '@/db/appSettings';
import { migrateDatabase } from '@/db/migrations';
import { insertPendingSubmission, listPendingSubmissions } from '@/db/pendingSubmissions';
import { setDiagnosticSink } from '@/diagnostics/log';
import { parseLocalDate, type LocalDate } from '@/domain/dates';
import {
  APP_PROPERTY_FILE_ROLE,
  APP_PROPERTY_TAB_ID,
  EXPENSE_COLUMNS,
} from '@/domain/sheetContract';
import { AuthorizationError } from '@/google/authorization';

import { connectGoogle, type ConnectionRequest, type ConnectionState } from './connection';

const ALICE = 'sub-alice';
const BOB = 'sub-bob';
const HEADER = [...EXPENSE_COLUMNS];

let google: FakeGoogle;
let authorizer: FakeAuthorizer;
let device: TestDatabase;
let restoreSink: () => void;
let diagnostics: string[];

const date = (value: string) => parseLocalDate(value) as LocalDate;

function connect(request: ConnectionRequest = { interactive: true }, db = device) {
  return connectGoogle({ db: db.db, authorizer, fetch: google.fetch }, request);
}

function expectReady(state: ConnectionState): asserts state is Extract<ConnectionState, { kind: 'ready' }> {
  expect(state.kind).toBe('ready');
}

function writes() {
  return [...google.requests('POST'), ...google.requests('PUT'), ...google.requests('PATCH')];
}

async function freshDevice(): Promise<TestDatabase> {
  const db = openTestDatabase();
  await migrateDatabase(db.db);
  return db;
}

async function addPending(db: TestDatabase, accountId: string, spreadsheetId: string, id = 'pending-1') {
  await insertPendingSubmission(
    db.db,
    { accountId, spreadsheetId },
    {
      submissionId: id,
      createdAt: '2026-11-22T01:00:00.000Z',
      purchaseDate: date('2026-11-21'),
      description: 'Lunch',
      amountMinor: 1_550,
      category: 'Eating out',
    },
  );
}

beforeEach(async () => {
  google = new FakeGoogle();
  google.addAccount(ALICE, 'alice@example.com');
  google.addAccount(BOB, 'bob@example.com');
  authorizer = new FakeAuthorizer(google, [ALICE]);
  device = await freshDevice();
  diagnostics = [];
  restoreSink = setDiagnosticSink((line) => diagnostics.push(line));
});

afterEach(() => {
  restoreSink();
  device.close();
});

describe('first connection', () => {
  test('creates exactly one tagged "My Expenses" spreadsheet with the Expenses header', async () => {
    const state = await connect();
    expectReady(state);
    expect(state.created).toBe(true);

    const files = google.appFiles(ALICE);
    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file?.name).toBe('My Expenses');
    expect(file?.appProperties[APP_PROPERTY_FILE_ROLE]).toBe('expenses');
    expect(file?.appProperties[APP_PROPERTY_TAB_ID]).toBe('0');
    expect(file?.tabs).toEqual([{ sheetId: 0, title: 'Expenses', index: 0, frozenRowCount: 1, rows: [HEADER] }]);

    // Creation and tagging happen in one request.
    const [create] = google.requests('POST', '/drive/v3/files');
    expect(create?.body).toMatchObject({
      name: 'My Expenses',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      appProperties: { [APP_PROPERTY_FILE_ROLE]: 'expenses' },
    });

    expect(await getAppSettings(device.db)).toMatchObject({
      googleAccountId: ALICE,
      googleAccountEmail: 'alice@example.com',
      spreadsheetId: file?.id,
      expensesSheetId: 0,
    });
  });

  test('asks for identity and drive.file only', async () => {
    await connect();
    expect(authorizer.calls[0]?.scopes).toEqual([
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/drive.file',
    ]);
  });

  test('falls back to tagging after creation if Drive ignores appProperties on create', async () => {
    google.dropAppPropertiesOnCreate = true;
    expectReady(await connect());
    const [file] = google.appFiles(ALICE);
    expect(file?.appProperties[APP_PROPERTY_FILE_ROLE]).toBe('expenses');
    expect(google.appFiles(ALICE)).toHaveLength(1);
  });

  test('diagnostics never include the account email, IDs or tokens', async () => {
    await connect();
    const output = diagnostics.join('\n');
    expect(output).toContain('google.connection_result');
    expect(output).not.toMatch(/alice|example\.com|sub-|file-|fake-token/);
  });
});

describe('repeated setup', () => {
  test('reuses the same spreadsheet and writes nothing', async () => {
    const first = await connect();
    expectReady(first);
    const writesAfterFirst = writes().length;

    const second = await connect({ interactive: false });
    const third = await connect({ interactive: true });

    expectReady(second);
    expectReady(third);
    expect(second.created).toBe(false);
    expect(second.spreadsheetId).toBe(first.spreadsheetId);
    expect(google.appFiles(ALICE)).toHaveLength(1);
    expect(writes()).toHaveLength(writesAfterFirst);
  });

  test('renaming the file and the tab does not break the connection', async () => {
    const first = await connect();
    expectReady(first);
    const file = google.files.get(first.spreadsheetId);
    if (file === undefined) throw new Error('missing file');
    file.name = 'Household budget 2026';
    const tab = file.tabs[0];
    if (tab === undefined) throw new Error('missing tab');
    tab.title = 'Spending log';

    const again = await connect({ interactive: false });
    expectReady(again);
    expect(again.spreadsheetId).toBe(first.spreadsheetId);
    expect(file.tabs.map((t) => t.title)).toEqual(['Spending log']);
    expect((await getAppSettings(device.db)).expensesSheetId).toBe(0);
  });
});

describe('reinstall recovery', () => {
  test('finds the existing tagged spreadsheet by app property, not by name', async () => {
    const first = await connect();
    expectReady(first);
    const file = google.files.get(first.spreadsheetId);
    if (file === undefined || file.tabs[0] === undefined) throw new Error('missing file');
    file.name = 'Renamed by user';
    file.tabs[0].title = 'Renamed tab';
    file.tabs[0].rows.push(['2026-11-20', 'Bus', 3.8, 'Transport', 'id-1']);

    // Reinstall: empty local database and a fresh authorizer, same Google account.
    const reinstalled = await freshDevice();
    authorizer = new FakeAuthorizer(google, [ALICE]);
    const writesBefore = writes().length;

    const state = await connect({ interactive: true }, reinstalled);
    expectReady(state);
    expect(state.created).toBe(false);
    expect(state.spreadsheetId).toBe(first.spreadsheetId);
    expect(google.appFiles(ALICE)).toHaveLength(1);
    expect(await getAppSettings(reinstalled.db)).toMatchObject({ googleAccountId: ALICE, expensesSheetId: 0 });
    expect(file.tabs[0].rows).toEqual([HEADER, ['2026-11-20', 'Bus', 3.8, 'Transport', 'id-1']]);
    expect(writes()).toHaveLength(writesBefore);
    reinstalled.close();
  });

  test('ignores spreadsheets the app did not create (drive.file), even if named "My Expenses"', async () => {
    const foreign = google.seedAppFile(ALICE, { name: 'My Expenses', createdByApp: false });
    const state = await connect();
    expectReady(state);
    expect(state.created).toBe(true);
    expect(state.spreadsheetId).not.toBe(foreign.id);
  });

  test('presents a choice when several tagged spreadsheets exist, and uses the chosen one', async () => {
    const older = google.seedAppFile(ALICE, { appProperties: { [APP_PROPERTY_FILE_ROLE]: 'expenses' } });
    const newer = google.seedAppFile(ALICE, { appProperties: { [APP_PROPERTY_FILE_ROLE]: 'expenses' } });

    const state = await connect();
    expect(state).toMatchObject({
      kind: 'choose_spreadsheet',
      candidates: [{ id: older.id }, { id: newer.id }],
    });
    expect((await getAppSettings(device.db)).spreadsheetId).toBeNull();
    expect(google.requests('POST', '/drive/v3/files')).toHaveLength(0);

    const chosen = await connect({ interactive: true, chosenSpreadsheetId: newer.id });
    expectReady(chosen);
    expect(chosen.spreadsheetId).toBe(newer.id);
    expect(google.appFiles(ALICE)).toHaveLength(2);
    expect(older.tabs[0]?.rows).toEqual([]);
  });

  test('a spreadsheet only in the trash is reported instead of silently creating another', async () => {
    google.seedAppFile(ALICE, { appProperties: { [APP_PROPERTY_FILE_ROLE]: 'expenses' }, trashed: true });
    const state = await connect();
    expect(state.kind).toBe('spreadsheet_trashed');
    expect(google.appFiles(ALICE)).toHaveLength(1);
  });
});

describe('interrupted initialization', () => {
  test('a create whose response was lost is found and finished on retry, not duplicated', async () => {
    google.failNext({ method: 'POST', pathIncludes: '/drive/v3/files', response: 'network_after_commit' });

    expect((await connect()).kind).toBe('offline');
    expect(google.appFiles(ALICE)).toHaveLength(1);
    expect((await getAppSettings(device.db)).spreadsheetId).toBeNull();

    const retry = await connect();
    expectReady(retry);
    expect(retry.created).toBe(false);
    expect(google.appFiles(ALICE)).toHaveLength(1);
    expect(google.appFiles(ALICE)[0]?.tabs).toMatchObject([{ title: 'Expenses', rows: [HEADER] }]);
  });

  test('a failure after renaming the tab but before the header resumes without a second tab', async () => {
    google.failNext({ method: 'PUT', pathIncludes: '/values/', response: { status: 503 } });

    expect((await connect()).kind).toBe('failed');
    const [file] = google.appFiles(ALICE);
    expect(file?.tabs).toMatchObject([{ title: 'Expenses', rows: [] }]);

    expectReady(await connect());
    expect(file?.tabs).toMatchObject([{ title: 'Expenses', rows: [HEADER] }]);
    expect(google.requests('PUT', '/values/')).toHaveLength(2);
  });

  test('an adopted file whose single tab has data gets a separate Expenses tab', async () => {
    const file = google.seedAppFile(ALICE, { appProperties: { [APP_PROPERTY_FILE_ROLE]: 'expenses' } });
    file.tabs[0]?.rows.push(['notes the user typed']);

    expectReady(await connect());
    expect(file.tabs.map((t) => [t.title, t.rows])).toEqual([
      ['Sheet1', [['notes the user typed']]],
      ['Expenses', [HEADER]],
    ]);
    expect(file.appProperties[APP_PROPERTY_TAB_ID]).toBe(String(file.tabs[1]?.sheetId));
  });
});

describe('schema validation before writing', () => {
  test('a changed header is reported and nothing is written', async () => {
    const first = await connect();
    expectReady(first);
    const tab = google.files.get(first.spreadsheetId)?.tabs[0];
    if (tab === undefined) throw new Error('missing tab');
    tab.rows = [['Date', 'Description', 'Cost', 'Category', 'Expense ID'], ['2026-11-20', 'Bus', 3.8, 'Transport', 'x']];
    const before = writes().length;

    expect(await connect({ interactive: false })).toEqual({ kind: 'schema_invalid', problem: 'header_mismatch' });
    expect(writes()).toHaveLength(before);
    expect(tab.rows[0]?.[2]).toBe('Cost');
  });

  test('rows without a header are not relabelled', async () => {
    const first = await connect();
    expectReady(first);
    const tab = google.files.get(first.spreadsheetId)?.tabs[0];
    if (tab === undefined) throw new Error('missing tab');
    tab.rows = [[], ['2026-11-20', 'Bus', 3.8, 'Transport', 'x']];
    const before = writes().length;

    expect(await connect({ interactive: false })).toEqual({ kind: 'schema_invalid', problem: 'data_without_header' });
    expect(writes()).toHaveLength(before);
  });
});

describe('authorization outcomes', () => {
  test('cancelling leaves setup untouched and recoverable', async () => {
    authorizer.userActions.push('cancel');
    expect(await connect()).toEqual({ kind: 'cancelled' });
    expect(google.appFiles(ALICE)).toHaveLength(0);
    expect(await getAppSettings(device.db)).toMatchObject({ googleAccountId: null, spreadsheetId: null });

    expectReady(await connect());
    expect(google.appFiles(ALICE)).toHaveLength(1);
  });

  test('declining the Drive permission is actionable and recoverable', async () => {
    authorizer.userActions.push('approve_without_drive');
    expect(await connect()).toEqual({ kind: 'permission_missing' });
    expect(google.appFiles(ALICE)).toHaveLength(0);

    expectReady(await connect());
  });

  test('revoked access asks the user to reconnect, then reuses the same spreadsheet', async () => {
    const first = await connect();
    expectReady(first);
    google.revoke(ALICE);

    expect(await connect({ interactive: false })).toEqual({ kind: 'reconnect_required' });

    const reconnected = await connect({ interactive: true });
    expectReady(reconnected);
    expect(reconnected.spreadsheetId).toBe(first.spreadsheetId);
    expect(google.appFiles(ALICE)).toHaveLength(1);
  });

  test('an expired token is cleared and replaced silently', async () => {
    expectReady(await connect());
    google.failNext({ pathIncludes: '/drive/v3/files/', response: { status: 401, reason: 'authError' } });

    expectReady(await connect({ interactive: false }));
    expect(authorizer.clearedTokens).toHaveLength(1);
  });

  test('access revoked mid-flow (token rejected, silent refresh needs the user) asks to reconnect', async () => {
    expectReady(await connect());
    google.failNext({ pathIncludes: '/drive/v3/files/', response: { status: 401, reason: 'authError' } });
    const realAuthorize = authorizer.authorize.bind(authorizer);
    let calls = 0;
    jest.spyOn(authorizer, 'authorize').mockImplementation(async (request) => {
      calls += 1;
      return calls === 1 ? realAuthorize(request) : { type: 'needs_user_interaction' };
    });

    expect(await connect({ interactive: false })).toEqual({ kind: 'reconnect_required' });
    expect(authorizer.clearedTokens).toHaveLength(1);
  });

  test('missing native module (Expo Go) is reported as unavailable', async () => {
    authorizer.available = false;
    expect(await connect()).toEqual({ kind: 'unavailable' });
  });

  test('an unregistered package/SHA-1 is reported as misconfigured', async () => {
    authorizer.throwOnAuthorize = new AuthorizationError('misconfigured');
    expect(await connect()).toEqual({ kind: 'misconfigured' });
  });

  test('a Drive/Sheets API that is not enabled in Google Cloud is reported as misconfigured', async () => {
    google.failNext({ pathIncludes: '/drive/v3/files', response: { status: 403, reason: 'accessNotConfigured' } });
    expect(await connect()).toEqual({ kind: 'misconfigured' });
  });

  test('network loss is reported as offline and leaves setup incomplete', async () => {
    google.failNext({ pathIncludes: '/drive/v3/files', response: 'network' });
    expect(await connect()).toEqual({ kind: 'offline' });
    expect((await getAppSettings(device.db)).spreadsheetId).toBeNull();
    expectReady(await connect());
  });

  test('a request timeout is reported as offline', async () => {
    jest.useFakeTimers();
    try {
      google.failNext({ pathIncludes: '/oauth2/v3/userinfo', response: 'timeout' });
      const pending = connect();
      await jest.advanceTimersByTimeAsync(21_000);
      expect(await pending).toEqual({ kind: 'offline' });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('missing or trashed spreadsheet', () => {
  test('a deleted file is actionable; creating a new one moves pending expenses to it', async () => {
    const first = await connect();
    expectReady(first);
    await addPending(device, ALICE, first.spreadsheetId);
    const old = google.files.get(first.spreadsheetId);
    if (old === undefined) throw new Error('missing file');
    old.deleted = true;

    expect(await connect({ interactive: false })).toEqual({ kind: 'spreadsheet_missing' });

    const replaced = await connect({ interactive: true, createNewSpreadsheet: true });
    expectReady(replaced);
    expect(replaced.spreadsheetId).not.toBe(first.spreadsheetId);
    const pending = await listPendingSubmissions(device.db, { accountId: ALICE, spreadsheetId: replaced.spreadsheetId });
    expect(pending.map((p) => p.submissionId)).toEqual(['pending-1']);
  });

  test('a trashed file is actionable and works again once restored', async () => {
    const first = await connect();
    expectReady(first);
    const file = google.files.get(first.spreadsheetId);
    if (file === undefined) throw new Error('missing file');
    file.trashed = true;

    expect(await connect({ interactive: false })).toEqual({ kind: 'spreadsheet_trashed' });
    file.trashed = false;
    const restored = await connect({ interactive: false });
    expectReady(restored);
    expect(restored.spreadsheetId).toBe(first.spreadsheetId);
  });
});

describe('account binding', () => {
  beforeEach(() => {
    authorizer.deviceAccounts = [ALICE, BOB];
  });

  test('a different account cannot be used while the bound account has pending expenses', async () => {
    const first = await connect();
    expectReady(first);
    await addPending(device, ALICE, first.spreadsheetId);

    authorizer.chooserPick = BOB;
    const state = await connect({ interactive: true, selectAccount: true });
    expect(state).toEqual({
      kind: 'account_mismatch',
      boundEmail: 'alice@example.com',
      selectedEmail: 'bob@example.com',
      pendingCount: 1,
    });

    const forced = await connect({ interactive: true, accountEmail: 'bob@example.com', confirmAccountSwitch: true });
    expect(forced.kind).toBe('account_mismatch');

    expect(await getAppSettings(device.db)).toMatchObject({ googleAccountId: ALICE, spreadsheetId: first.spreadsheetId });
    expect(google.appFiles(BOB)).toHaveLength(0);
    const alicePending = await listPendingSubmissions(device.db, { accountId: ALICE, spreadsheetId: first.spreadsheetId });
    expect(alicePending).toHaveLength(1);
  });

  test('with nothing pending, switching needs explicit confirmation and uses the new account’s own file', async () => {
    const first = await connect();
    expectReady(first);

    authorizer.chooserPick = BOB;
    expect(await connect({ interactive: true, selectAccount: true })).toMatchObject({
      kind: 'account_mismatch',
      pendingCount: 0,
    });
    expect((await getAppSettings(device.db)).googleAccountId).toBe(ALICE);

    const switched = await connect({ interactive: true, accountEmail: 'bob@example.com', confirmAccountSwitch: true });
    expectReady(switched);
    expect(switched.accountEmail).toBe('bob@example.com');
    expect(switched.spreadsheetId).not.toBe(first.spreadsheetId);
    expect(google.appFiles(BOB)).toHaveLength(1);
    expect(await getAppSettings(device.db)).toMatchObject({
      googleAccountId: BOB,
      googleAccountEmail: 'bob@example.com',
      spreadsheetId: switched.spreadsheetId,
    });
  });
});
