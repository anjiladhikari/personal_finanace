import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { FakeAuthorizer, FakeGoogle } from '../test/fakeGoogle';
import { openTestDatabase, type TestDatabase } from '../test/sqliteTestDatabase';

import { getAppSettings } from '@/db/appSettings';
import { migrateDatabase } from '@/db/migrations';
import type { SqlDatabase } from '@/db/sql';
import type { GoogleServices } from '@/google/services';
import { connectGoogle } from '@/sync/connection';

// Real in-memory SQLite instead of the native expo-sqlite provider.
let mockDatabase: SqlDatabase | null = null;
jest.mock('@/db/DatabaseProvider', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { DatabaseContext } = jest.requireActual<typeof import('@/db/DatabaseContext')>('@/db/DatabaseContext');
  return {
    DatabaseProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(DatabaseContext.Provider, { value: mockDatabase }, children),
  };
});

// Fake Google Drive/Sheets and a scripted AuthorizationClient.
let mockServices: GoogleServices | null = null;
jest.mock('@/google/services', () => ({ createDefaultGoogleServices: () => mockServices }));

const ALICE = 'sub-alice';
let testDb: TestDatabase;
let google: FakeGoogle;
let authorizer: FakeAuthorizer;
const globalFetch = jest.fn(() => Promise.reject(new Error('Network access is not allowed in this test')));

beforeEach(async () => {
  testDb = openTestDatabase();
  await migrateDatabase(testDb.db);
  mockDatabase = testDb.db;
  google = new FakeGoogle();
  google.addAccount(ALICE, 'alice@example.com');
  authorizer = new FakeAuthorizer(google, [ALICE]);
  mockServices = { authorizer, fetch: google.fetch };
  globalFetch.mockClear();
  globalThis.fetch = globalFetch as unknown as typeof fetch;
});

afterEach(() => {
  testDb.close();
  mockDatabase = null;
  mockServices = null;
});

async function completeSetupBeforeLaunch() {
  const state = await connectGoogle({ db: testDb.db, authorizer, fetch: google.fetch }, { interactive: true });
  expect(state.kind).toBe('ready');
  google.log.length = 0;
  authorizer.calls.length = 0;
}

describe('before setup', () => {
  test('the app opens on Setup, without contacting Google until the user taps Connect', async () => {
    const router = await renderRouter('src/app');

    expect(await screen.findByTestId('setup-screen')).toBeOnTheScreen();
    expect(router.getPathname()).toBe('/setup');
    expect(authorizer.calls).toHaveLength(0);
    expect(google.log).toHaveLength(0);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  test('Connect Google provisions the spreadsheet and lands on Add expense', async () => {
    const router = await renderRouter('src/app');

    await fireEvent.press(await screen.findByTestId('connect-google'));

    expect(await screen.findByTestId('add-expense-screen')).toBeOnTheScreen();
    expect(router.getPathname()).toBe('/');
    expect(google.appFiles(ALICE)).toHaveLength(1);
    expect(await getAppSettings(testDb.db)).toMatchObject({ googleAccountId: ALICE, expensesSheetId: 0 });
  });

  test('cancelling stays on Setup with a way to try again', async () => {
    authorizer.userActions.push('cancel');
    const router = await renderRouter('src/app');

    await fireEvent.press(await screen.findByTestId('connect-google'));

    expect(await screen.findByText('Google connection was cancelled')).toBeOnTheScreen();
    expect(router.getPathname()).toBe('/setup');
    expect(google.appFiles(ALICE)).toHaveLength(0);

    await fireEvent.press(screen.getByTestId('connect-google'));
    expect(await screen.findByTestId('add-expense-screen')).toBeOnTheScreen();
  });

  test('declining the Drive permission explains what to allow', async () => {
    authorizer.userActions.push('approve_without_drive');
    await renderRouter('src/app');

    await fireEvent.press(await screen.findByTestId('connect-google'));

    expect(await screen.findByText('Drive permission is needed')).toBeOnTheScreen();
    expect(screen.getByTestId('retry')).toBeOnTheScreen();
  });
});

describe('after setup', () => {
  test('Add expense is the initial route and renders from local data only', async () => {
    await completeSetupBeforeLaunch();
    const router = await renderRouter('src/app');

    expect(await screen.findByTestId('add-expense-screen')).toBeOnTheScreen();
    expect(router.getPathname()).toBe('/');
    expect(await screen.findByText('Amounts are in AUD.')).toBeOnTheScreen();
    expect(google.log).toHaveLength(0);
    expect(authorizer.calls).toHaveLength(0);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  test('My spending is reachable from the tab bar', async () => {
    await completeSetupBeforeLaunch();
    const router = await renderRouter('src/app');

    await fireEvent.press(await screen.findByTestId('tab-my-spending'));
    expect(await screen.findByTestId('my-spending-screen')).toBeOnTheScreen();
    expect(router.getPathname()).toBe('/spending');

    await fireEvent.press(screen.getByTestId('tab-add-expense'));
    expect(await screen.findByTestId('add-expense-screen')).toBeOnTheScreen();
  });

  test('Account → Check connection after access was revoked offers Reconnect, which repairs it', async () => {
    await completeSetupBeforeLaunch();
    google.revoke(ALICE);
    const router = await renderRouter('src/app');

    await fireEvent.press(await screen.findByTestId('open-account'));
    expect(await screen.findByTestId('account-screen')).toBeOnTheScreen();
    expect(router.getPathname()).toBe('/account');
    expect(screen.getByTestId('account-email')).toHaveTextContent('alice@example.com');

    await fireEvent.press(screen.getByTestId('check-connection'));
    expect(await screen.findByText('Google access needs to be renewed')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('reconnect-google'));
    expect(await screen.findByText('Connected as alice@example.com')).toBeOnTheScreen();
    expect(google.appFiles(ALICE)).toHaveLength(1);
  });

  test('Account → Use a different Google account asks before switching', async () => {
    await completeSetupBeforeLaunch();
    google.addAccount('sub-bob', 'bob@example.com');
    authorizer.deviceAccounts = [ALICE, 'sub-bob'];
    authorizer.chooserPick = 'sub-bob';
    await renderRouter('src/app');

    await fireEvent.press(await screen.findByTestId('open-account'));
    await fireEvent.press(await screen.findByTestId('choose-account'));
    expect(await screen.findByText('This phone is set up for alice@example.com')).toBeOnTheScreen();
    expect((await getAppSettings(testDb.db)).googleAccountId).toBe(ALICE);

    await fireEvent.press(screen.getByTestId('confirm-switch'));
    expect(await screen.findByText('Connected as bob@example.com')).toBeOnTheScreen();
    expect((await getAppSettings(testDb.db)).googleAccountId).toBe('sub-bob');
  });

  test('Account → Check connection reports a deleted spreadsheet with a create-new action', async () => {
    await completeSetupBeforeLaunch();
    const [file] = google.appFiles(ALICE);
    if (file === undefined) throw new Error('missing file');
    file.deleted = true;
    await renderRouter('src/app');

    await fireEvent.press(await screen.findByTestId('open-account'));
    await fireEvent.press(await screen.findByTestId('check-connection'));
    expect(await screen.findByText('The app can\'t find “My Expenses”')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('create-new'));
    expect(await screen.findByText('Connected as alice@example.com')).toBeOnTheScreen();
    expect(google.appFiles(ALICE)).toHaveLength(1);
    expect(google.appFiles(ALICE)[0]?.id).not.toBe(file.id);
  });
});
