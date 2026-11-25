/**
 * Performance measurements on a ten-year, 36,500-row ledger.
 *
 *   PERF=1 npx jest src/performance.test.tsx --runInBand
 *
 * PERF_OUT=<file> also writes the results as JSON; PERF_TSV=<file> writes the
 * synthetic ledger as tab-separated rows for importing into a test sheet.
 *
 * Skipped in `npm run check`. Runs on the development machine with Node,
 * better-sqlite3 and the fake Google backend, so the numbers show relative
 * cost and catch regressions; they are not phone measurements.
 */
import { writeFileSync } from 'node:fs';
import os from 'node:os';

import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import { FakeAuthorizer, FakeGoogle } from '../test/fakeGoogle';
import { LARGE_LEDGER_DAYS, LARGE_LEDGER_PER_DAY, largeLedgerRows } from '../test/fixtures/largeLedger';
import { openTestDatabase, type TestDatabase } from '../test/sqliteTestDatabase';

import { countConfirmedExpenses } from '@/db/ledgerCache';
import { migrateDatabase } from '@/db/migrations';
import { analyzeSpending } from '@/db/spendingAnalysis';
import type { SqlDatabase } from '@/db/sql';
import { parseLocalDate, type LocalDate, type Period } from '@/domain/dates';
import type { DataScope } from '@/domain/expense';
import { buildLedger } from '@/domain/ledger';
import type { GoogleServices } from '@/google/services';
import { connectGoogle } from '@/sync/connection';
import { LEDGER_SLICE_ROWS, REFRESH_CHUNK_ROWS, validateInSlices } from '@/sync/refresh';
import { SubmissionEngine } from '@/sync/submissions';

// Captured before renderRouter installs fake timers.
const now = performance.now.bind(performance);

let mockDatabase: SqlDatabase | null = null;
jest.mock('@/db/DatabaseProvider', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { DatabaseContext } = jest.requireActual<typeof import('@/db/DatabaseContext')>('@/db/DatabaseContext');
  return {
    DatabaseProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(DatabaseContext.Provider, { value: mockDatabase }, children),
  };
});

let mockServices: GoogleServices | null = null;
jest.mock('@/google/services', () => ({ createDefaultGoogleServices: () => mockServices }));

jest.mock('@/sync/platform', () => ({
  createPlatformServices: () => ({
    isOnline: async () => true,
    onConnectivityRegained: () => () => undefined,
    newId: () => 'unused',
    now: () => Date.parse('2026-11-22T03:04:00Z'),
  }),
}));

const ALICE = 'sub-alice';
const ROWS = LARGE_LEDGER_DAYS * LARGE_LEDGER_PER_DAY;
const d = (value: string) => parseLocalDate(value) as LocalDate;
const run = process.env.PERF === '1' ? describe : describe.skip;

interface Stats {
  readonly runs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

function stats(samples: readonly number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (ms: number) => Math.round(ms * 100) / 100;
  return { runs: sorted.length, medianMs: round(at(0.5)), p95Ms: round(at(0.95)), maxMs: round(sorted.at(-1) ?? 0) };
}

async function time<T>(work: () => Promise<T> | T): Promise<[T, number]> {
  const start = now();
  const result = await work();
  return [result, now() - start];
}

const results: Record<string, unknown> = {};

run('ten-year ledger (36,500 rows)', () => {
  let testDb: TestDatabase;
  let google: FakeGoogle;
  let authorizer: FakeAuthorizer;
  let scope: DataScope;
  let engine: SubmissionEngine;

  beforeAll(async () => {
    testDb = openTestDatabase();
    await migrateDatabase(testDb.db);
    mockDatabase = testDb.db;
    google = new FakeGoogle();
    google.addAccount(ALICE, 'alice@example.com');
    authorizer = new FakeAuthorizer(google, [ALICE]);
    mockServices = { authorizer, fetch: google.fetch };
    const state = await connectGoogle({ db: testDb.db, authorizer, fetch: google.fetch }, { interactive: true });
    if (state.kind !== 'ready') throw new Error('setup failed');
    scope = { accountId: ALICE, spreadsheetId: state.spreadsheetId };
    const rows = largeLedgerRows();
    const tsv = process.env.PERF_TSV;
    if (tsv !== undefined && tsv !== '') writeFileSync(tsv, `${rows.map((cells) => cells.join('\t')).join('\n')}\n`);
    google.seedExpenseRows(scope.spreadsheetId, rows);
    engine = new SubmissionEngine({
      db: testDb.db,
      authorizer,
      fetch: google.fetch,
      isOnline: async () => true,
      newId: () => 'unused',
      now: () => Date.parse('2026-11-22T03:04:00Z'),
    });
    results.environment = {
      machine: `${os.cpus()[0]?.model ?? 'unknown'} (${os.cpus().length} cores), ${Math.round(os.totalmem() / 2 ** 30)} GB`,
      os: `${os.type()} ${os.release()}`,
      node: process.version,
      database: 'better-sqlite3 (test adapter for the app SqlDatabase interface)',
      google: 'in-process fake (no network latency)',
      rows: ROWS,
      span: `${rows[0]?.[0] as string} to ${rows.at(-1)?.[0] as string}`,
      refreshChunkRows: REFRESH_CHUNK_ROWS,
    };
  });

  afterAll(() => {
    testDb.close();
    const out = process.env.PERF_OUT;
    const text = `${JSON.stringify(results, null, 2)}\n`;
    if (out !== undefined && out !== '') writeFileSync(out, text);
    process.stdout.write(text);
  });

  test('full refresh: read, validate and replace the cache', async () => {
    const durations: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      google.log.length = 0;
      const [outcome, ms] = await time(() => engine.refresh());
      expect(outcome).toMatchObject({ kind: 'refreshed' });
      durations.push(ms);
      results.refreshRequests = google.log.length;
    }
    expect(await countConfirmedExpenses(testDb.db, scope)).toBe(ROWS);
    results.fullRefresh = { firstMs: Math.round(durations[0] ?? 0), ...stats(durations) };
  });

  test('ledger validation in one pass (before slicing, the longest synchronous step)', async () => {
    const rows = largeLedgerRows().map((cells, index) => ({ tab: String(cells[0]).slice(0, 4), rowNumber: index + 2, cells }));
    const samples: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const [ledger, ms] = await time(() => buildLedger(rows, 2));
      expect(ledger.expenses).toHaveLength(ROWS);
      samples.push(ms);
    }
    results.buildLedger = stats(samples);
  });

  test('refresh validation in slices: longest single block on the JS thread', async () => {
    const rows = largeLedgerRows().map((cells, index) => ({ tab: String(cells[0]).slice(0, 4), rowNumber: index + 2, cells }));
    const blocks: number[] = [];
    let sliceStart = now();
    const [ledger, totalMs] = await time(() =>
      validateInSlices(rows, 2, async () => {
        blocks.push(now() - sliceStart);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        sliceStart = now();
      }),
    );
    blocks.push(now() - sliceStart); // last slice plus finishing (duplicate check, sort)
    expect(ledger.expenses).toHaveLength(ROWS);
    results.slicedValidation = { sliceRows: LEDGER_SLICE_ROWS, slices: blocks.length, totalMs: Math.round(totalMs), block: stats(blocks) };
  });

  test('period queries from the local cache', async () => {
    const periods: [string, Period][] = [
      ['day', { kind: 'day', date: d('2026-10-08') }],
      ['month', { kind: 'month', year: 2026, month: 10 }],
      ['year', { kind: 'year', year: 2026 }],
      ['all', { kind: 'all' }],
    ];
    google.log.length = 0;
    const queries: Record<string, Stats> = {};
    for (const [name, period] of periods) {
      const samples: number[] = [];
      for (let i = 0; i < 50; i += 1) {
        const [analysis, ms] = await time(() => analyzeSpending(testDb.db, scope, period));
        expect(analysis.totalMinor).toBeGreaterThan(0);
        samples.push(ms);
      }
      queries[name] = stats(samples);
    }
    expect(google.log).toHaveLength(0);
    results.periodQueries = queries;
  });

  test('app start to a ready Add expense form, then My spending', async () => {
    google.log.length = 0;
    const [, formMs] = await time(async () => {
      await renderRouter('src/app');
      await screen.findByTestId('save-expense');
    });
    await act(() => jest.advanceTimersByTimeAsync(60_000));
    const ledgerReads = google.requests('GET', '/values/').filter((r) => !r.path.includes('A1%3AE2')).length;
    expect(ledgerReads).toBe(0);

    const [, spendingMs] = await time(async () => {
      await fireEvent.press(screen.getByTestId('tab-my-spending'));
      await screen.findByTestId('period-total');
    });
    const [, switchMs] = await time(async () => {
      await fireEvent.press(screen.getByTestId('period-all'));
      await waitFor(() => expect(screen.getByTestId('period-label')).toHaveTextContent('All time'));
    });
    expect(google.requests('GET', '/values/').filter((r) => !r.path.includes('A1%3AE2'))).toHaveLength(0);
    results.screens = {
      formReadyMs: Math.round(formMs),
      ledgerReadsOnEntry: ledgerReads,
      openMySpendingMs: Math.round(spendingMs),
      switchToAllTimeMs: Math.round(switchMs),
    };
  });
});

test('performance suite is opt-in (PERF=1)', () => {
  expect(ROWS).toBe(36_500);
});
