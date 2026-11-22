import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { openTestDatabase, type TestDatabase } from '../test/sqliteTestDatabase';

import { migrateDatabase } from '@/db/migrations';
import type { SqlDatabase } from '@/db/sql';

// Replace the expo-sqlite provider (native) with a real in-memory SQLite
// database exposed through the same context the screens use.
let mockDatabase: SqlDatabase | null = null;
jest.mock('@/db/DatabaseProvider', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { DatabaseContext } = jest.requireActual<typeof import('@/db/DatabaseContext')>(
    '@/db/DatabaseContext',
  );
  return {
    DatabaseProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(DatabaseContext.Provider, { value: mockDatabase }, children),
  };
});

let testDb: TestDatabase;
const fetchMock = jest.fn(() => Promise.reject(new Error('Network access is not allowed in this test')));

beforeEach(async () => {
  testDb = openTestDatabase();
  await migrateDatabase(testDb.db);
  mockDatabase = testDb.db;
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  testDb.close();
  mockDatabase = null;
});

test('the initial route is Add expense and renders from local data without any network request', async () => {
  const router = await renderRouter('src/app');

  expect(router.getPathname()).toBe('/');
  expect(await screen.findByTestId('add-expense-screen')).toBeOnTheScreen();
  expect(await screen.findByText('Amounts are in AUD.')).toBeOnTheScreen();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('My spending is reachable from the tab bar', async () => {
  const router = await renderRouter('src/app');

  // RNTL 14 event helpers are async.
  await fireEvent.press(await screen.findByTestId('tab-my-spending'));

  expect(await screen.findByTestId('my-spending-screen')).toBeOnTheScreen();
  expect(router.getPathname()).toBe('/spending');

  await fireEvent.press(screen.getByTestId('tab-add-expense'));
  expect(await screen.findByTestId('add-expense-screen')).toBeOnTheScreen();
  expect(fetchMock).not.toHaveBeenCalled();
});
