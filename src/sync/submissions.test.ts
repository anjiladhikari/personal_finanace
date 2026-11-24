import { FakeAuthorizer, FakeGoogle } from '../../test/fakeGoogle';
import { openTestDatabase, type TestDatabase } from '../../test/sqliteTestDatabase';

import { listConfirmedExpenses, sumConfirmedSpending } from '@/db/confirmedExpenses';
import { getAppSettings } from '@/db/appSettings';
import { migrateDatabase } from '@/db/migrations';
import {
  insertPendingSubmission,
  listPendingSubmissions,
  markSending,
} from '@/db/pendingSubmissions';
import type { SqlDatabase } from '@/db/sql';
import { parseLocalDate, type LocalDate } from '@/domain/dates';
import type { DataScope, ExpensePayload } from '@/domain/expense';
import { ATTEMPT_TIMEOUT_MS, RECONCILE_SETTLE_MS } from '@/domain/submissionPolicy';
import type { FetchLike } from '@/google/http';

import { connectGoogle } from './connection';
import { SubmissionEngine, type SubmissionDeps } from './submissions';

const ALICE = 'sub-alice';
const T0 = Date.parse('2026-11-22T03:00:00Z');

let google: FakeGoogle;
let authorizer: FakeAuthorizer;
let device: TestDatabase;
let scope: DataScope;
let clock: number;
let online: boolean;
let idCounter: number;

const date = (value: string) => parseLocalDate(value) as LocalDate;
const coffee: ExpensePayload = {
  purchaseDate: date('2026-11-21'),
  description: 'Coffee',
  amountMinor: 450,
  category: 'Eating out',
};

function deps(overrides: Partial<SubmissionDeps> = {}): SubmissionDeps {
  return {
    db: device.db,
    authorizer,
    fetch: google.fetch,
    isOnline: async () => online,
    newId: () => `uuid-${(idCounter += 1)}`,
    now: () => clock,
    ...overrides,
  };
}

const appends = () => google.requests('POST', ':append');
const rows = () => google.dataRows(scope.spreadsheetId);
const pending = () => listPendingSubmissions(device.db, scope);
const confirmed = () => listConfirmedExpenses(device.db, scope, null);

beforeEach(async () => {
  google = new FakeGoogle();
  google.addAccount(ALICE, 'alice@example.com');
  authorizer = new FakeAuthorizer(google, [ALICE]);
  device = openTestDatabase();
  await migrateDatabase(device.db);
  const state = await connectGoogle({ db: device.db, authorizer, fetch: google.fetch }, { interactive: true });
  if (state.kind !== 'ready') throw new Error(`setup failed: ${state.kind}`);
  scope = { accountId: ALICE, spreadsheetId: state.spreadsheetId };
  google.log.length = 0;
  clock = T0;
  online = true;
  idCounter = 0;
});

afterEach(() => {
  jest.useRealTimers();
  device.close();
});

describe('confirmed save', () => {
  test('writes Date | Description | Amount | Category | Expense ID with RAW values and completes locally', async () => {
    const outcome = await new SubmissionEngine(deps()).submit(coffee);

    expect(outcome).toEqual({ kind: 'confirmed', submissionId: 'uuid-1' });
    expect(rows()).toEqual([['2026-11-21', 'Coffee', 4.5, 'Eating out', 'uuid-1']]);
    const [append] = appends();
    expect(append?.body).toMatchObject({ values: [['2026-11-21', 'Coffee', 4.5, 'Eating out', 'uuid-1']] });
    expect(await pending()).toEqual([]);
    expect(await confirmed()).toEqual([{ expenseId: 'uuid-1', ...coffee }]);
  });

  test('a confirmed save records its own time, separate from the last full refresh', async () => {
    expect(await getAppSettings(device.db)).toMatchObject({ lastConfirmedSaveAt: null, lastSuccessfulSyncAt: null });
    clock = T0 + 5_000;

    await new SubmissionEngine(deps()).submit(coffee);

    expect(await getAppSettings(device.db)).toMatchObject({
      lastConfirmedSaveAt: new Date(T0 + 5_000).toISOString(),
      lastSuccessfulSyncAt: null,
    });
  });

  test('a save that is not confirmed leaves the confirmed save time unchanged', async () => {
    online = false;
    await new SubmissionEngine(deps()).submit(coffee);
    expect((await getAppSettings(device.db)).lastConfirmedSaveAt).toBeNull();
  });

  test('formula-like descriptions are sent as literal text', async () => {
    await new SubmissionEngine(deps()).submit({ ...coffee, description: '=IMPORTXML("http://x","//a")' });
    expect(rows()[0]?.[1]).toBe('=IMPORTXML("http://x","//a")');
    expect(google.requests('POST', ':append')[0]?.path).toContain(':append');
  });

  test('the payload is persisted before the request is sent', async () => {
    const statesAtSend: string[] = [];
    const spying: FetchLike = async (url, init) => {
      if (url.includes(':append')) {
        const row = device.raw.prepare('SELECT state FROM pending_submissions').get() as { state: string } | undefined;
        statesAtSend.push(row?.state ?? 'none');
      }
      return google.fetch(url, init);
    };
    await new SubmissionEngine(deps({ fetch: spying })).submit(coffee);
    expect(statesAtSend).toEqual(['sending']);
  });

  test('identical purchases saved twice are two expenses with distinct IDs', async () => {
    const engine = new SubmissionEngine(deps());
    const first = await engine.submit(coffee);
    const second = await engine.submit(coffee);

    expect(first).toMatchObject({ kind: 'confirmed', submissionId: 'uuid-1' });
    expect(second).toMatchObject({ kind: 'confirmed', submissionId: 'uuid-2' });
    expect(rows().map((r) => r[4])).toEqual(['uuid-1', 'uuid-2']);
  });

  test('attempts are serialized: never two appends in flight', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const counting: FetchLike = async (url, init) => {
      if (!url.includes(':append')) return google.fetch(url, init);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await google.fetch(url, init);
      } finally {
        inFlight -= 1;
      }
    };
    const engine = new SubmissionEngine(deps({ fetch: counting }));

    const outcomes = await Promise.all([engine.submit(coffee), engine.submit(coffee), engine.processQueue('manual')]);

    expect(maxInFlight).toBe(1);
    expect(outcomes.slice(0, 2).map((o) => o?.kind)).toEqual(['confirmed', 'confirmed']);
    expect(rows()).toHaveLength(2);
  });
});

describe('offline', () => {
  test('saves locally without any Google request, then sends when connectivity returns', async () => {
    online = false;
    const engine = new SubmissionEngine(deps());

    const outcome = await engine.submit(coffee);

    expect(outcome).toEqual({ kind: 'unresolved', submissionId: 'uuid-1', state: 'pending', error: 'offline' });
    expect(google.log).toHaveLength(0);
    expect((await pending()).map((p) => p.submissionId)).toEqual(['uuid-1']);
    expect(await sumConfirmedSpending(device.db, scope, null)).toBe(0);

    online = true;
    await engine.processQueue('connectivity');
    expect(await engine.outcomeOf('uuid-1')).toEqual({ kind: 'confirmed', submissionId: 'uuid-1' });
    expect(await sumConfirmedSpending(device.db, scope, null)).toBe(450);
  });
});

describe('unknown outcomes', () => {
  test('a lost response after a successful write is reconciled by ID, not written again', async () => {
    google.failNext({ method: 'POST', pathIncludes: ':append', response: 'network_after_commit' });
    const engine = new SubmissionEngine(deps());

    expect(await engine.submit(coffee)).toEqual({
      kind: 'unresolved',
      submissionId: 'uuid-1',
      state: 'uncertain',
      error: 'offline',
    });
    expect(rows()).toHaveLength(1);

    await engine.processQueue('timer');
    expect(await engine.outcomeOf('uuid-1')).toMatchObject({ kind: 'confirmed' });
    expect(appends()).toHaveLength(1);
    expect(rows()).toHaveLength(1);
  });

  test('a temporarily absent ID is not treated as failure: no re-send before the settle window', async () => {
    jest.useFakeTimers();
    google.failNext({ method: 'POST', pathIncludes: ':append', response: 'deferred_commit' });
    const engine = new SubmissionEngine(deps());

    const saving = engine.submit(coffee);
    await jest.advanceTimersByTimeAsync(ATTEMPT_TIMEOUT_MS + 1);
    expect(await saving).toMatchObject({ state: 'uncertain', error: 'timeout' });

    clock = T0 + 60_000;
    await engine.processQueue('foreground');
    expect(appends()).toHaveLength(1);
    expect((await pending())[0]?.state).toBe('uncertain');

    await google.flushDeferredWrites(); // the timed-out request lands late
    await engine.processQueue('timer');
    expect(await engine.outcomeOf('uuid-1')).toMatchObject({ kind: 'confirmed' });
    expect(appends()).toHaveLength(1);
    expect(rows()).toHaveLength(1);
  });

  test('bounded reconciliation: after the settle window an absent ID is re-sent with the same UUID', async () => {
    jest.useFakeTimers();
    google.failNext({ method: 'POST', pathIncludes: ':append', response: 'deferred_commit' });
    const engine = new SubmissionEngine(deps());
    const saving = engine.submit(coffee);
    await jest.advanceTimersByTimeAsync(ATTEMPT_TIMEOUT_MS + 1);
    await saving;

    clock = T0 + RECONCILE_SETTLE_MS - 1_000;
    await engine.processQueue('manual');
    expect(appends()).toHaveLength(1);

    clock = T0 + RECONCILE_SETTLE_MS + 1_000;
    await engine.processQueue('timer');

    expect(await engine.outcomeOf('uuid-1')).toMatchObject({ kind: 'confirmed' });
    expect(appends().map((a) => (a.body as { values: unknown[][] }).values[0]?.[4])).toEqual(['uuid-1', 'uuid-1']);
    expect(rows()).toHaveLength(1);
  });

  test('residual risk: a request that lands after the settle window duplicates the row (same Expense ID)', async () => {
    jest.useFakeTimers();
    google.failNext({ method: 'POST', pathIncludes: ':append', response: 'deferred_commit' });
    const engine = new SubmissionEngine(deps());
    const saving = engine.submit(coffee);
    await jest.advanceTimersByTimeAsync(ATTEMPT_TIMEOUT_MS + 1);
    await saving;
    clock = T0 + RECONCILE_SETTLE_MS + 1_000;
    await engine.processQueue('timer');

    await google.flushDeferredWrites();

    expect(rows().map((r) => r[4])).toEqual(['uuid-1', 'uuid-1']);
    expect(await confirmed()).toHaveLength(1);
  });

  test('if the sheet cannot be read, the submission stays visibly uncertain', async () => {
    google.failNext({ method: 'POST', pathIncludes: ':append', response: 'network_after_commit' });
    const engine = new SubmissionEngine(deps());
    await engine.submit(coffee);

    google.failNext({ method: 'GET', pathIncludes: 'A2%3AE', response: 'network' });
    await engine.processQueue('timer');

    expect(await pending()).toMatchObject([{ submissionId: 'uuid-1', state: 'uncertain', lastError: { code: 'offline' } }]);
    expect(appends()).toHaveLength(1);
  });

  test('an uncertain submission is never moved to blocked (it must be reconciled first)', async () => {
    google.failNext({ method: 'POST', pathIncludes: ':append', response: 'network_after_commit' });
    const engine = new SubmissionEngine(deps());
    await engine.submit(coffee);
    google.revoke(ALICE);

    await engine.processQueue('manual');

    expect(await pending()).toMatchObject([{ state: 'uncertain', lastError: { code: 'auth_required' } }]);
  });
});

describe('app termination during a save', () => {
  async function crashAfterMarkingSending(): Promise<void> {
    await insertPendingSubmission(device.db, scope, { ...coffee, submissionId: 'crashed', createdAt: new Date(T0).toISOString() });
    await markSending(device.db, 'crashed', new Date(T0).toISOString());
  }

  test('if the write reached Google, the next launch confirms it from the sheet', async () => {
    await crashAfterMarkingSending();
    google.files.get(scope.spreadsheetId)?.tabs[0]?.rows.push(['2026-11-21', 'Coffee', 4.5, 'Eating out', 'crashed']);

    clock = T0 + 5_000;
    await new SubmissionEngine(deps()).processQueue('startup');

    expect(await pending()).toEqual([]);
    expect(await confirmed()).toEqual([{ expenseId: 'crashed', ...coffee }]);
    expect(appends()).toHaveLength(0);
  });

  test('if it did not, the next launch keeps it uncertain until the settle window, then sends it once', async () => {
    await crashAfterMarkingSending();
    const engine = new SubmissionEngine(deps());

    clock = T0 + 5_000;
    await engine.processQueue('startup');
    expect(await pending()).toMatchObject([{ submissionId: 'crashed', state: 'uncertain' }]);
    expect(appends()).toHaveLength(0);

    clock = T0 + RECONCILE_SETTLE_MS + 1_000;
    await engine.processQueue('timer');
    expect(await pending()).toEqual([]);
    expect(rows().map((r) => r[4])).toEqual(['crashed']);
  });
});

describe('remote success, local update failure', () => {
  test('the local record is rebuilt from the remote row on the next run', async () => {
    let failNextTransaction = true;
    const flaky: SqlDatabase = {
      ...device.db,
      transaction: (task) => {
        if (failNextTransaction) {
          failNextTransaction = false;
          return Promise.reject(new Error('disk I/O error'));
        }
        return device.db.transaction(task);
      },
    };
    const engine = new SubmissionEngine(deps({ db: flaky }));

    expect(await engine.submit(coffee)).toEqual({ kind: 'confirmed_remote_only', submissionId: 'uuid-1' });
    expect(rows()).toHaveLength(1);
    expect(await confirmed()).toEqual([]);
    expect(await pending()).toMatchObject([{ submissionId: 'uuid-1', state: 'sending' }]);

    // The sheet is the source of truth: it is what the local record is rebuilt from.
    const row = google.files.get(scope.spreadsheetId)?.tabs[0]?.rows[1];
    if (row === undefined) throw new Error('missing row');
    row[1] = 'Coffee with Sam';

    await engine.processQueue('timer');
    expect(await engine.outcomeOf('uuid-1')).toMatchObject({ kind: 'confirmed' });
    expect(await confirmed()).toEqual([{ expenseId: 'uuid-1', ...coffee, description: 'Coffee with Sam' }]);
    expect(appends()).toHaveLength(1);
  });
});

describe('actionable failures', () => {
  test('revoked access blocks without writing; Retry after reconnecting sends it', async () => {
    google.revoke(ALICE);
    const engine = new SubmissionEngine(deps());

    expect(await engine.submit(coffee)).toMatchObject({ state: 'blocked', error: 'auth_required' });
    expect(appends()).toHaveLength(0);

    await connectGoogle({ db: device.db, authorizer, fetch: google.fetch }, { interactive: true });
    expect(await engine.retry('uuid-1')).toMatchObject({ kind: 'confirmed' });
  });

  test('a changed header blocks writing so columns cannot be misaligned', async () => {
    const tab = google.files.get(scope.spreadsheetId)?.tabs[0];
    if (tab === undefined) throw new Error('missing tab');
    tab.rows[0] = ['Date', 'Amount', 'Description', 'Category', 'Expense ID'];

    expect(await new SubmissionEngine(deps()).submit(coffee)).toMatchObject({
      state: 'blocked',
      error: 'sheet_structure_changed',
    });
    expect(appends()).toHaveLength(0);
  });

  test('a deleted spreadsheet blocks with sheet_missing', async () => {
    const file = google.files.get(scope.spreadsheetId);
    if (file === undefined) throw new Error('missing file');
    file.deleted = true;
    expect(await new SubmissionEngine(deps()).submit(coffee)).toMatchObject({ state: 'blocked', error: 'sheet_missing' });
  });

  test('a token for a different Google account is never used to write', async () => {
    google.addAccount('sub-bob', 'bob@example.com');
    google.grant('sub-bob', ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/drive.file']);
    jest.spyOn(authorizer, 'authorize').mockResolvedValue({
      type: 'success',
      accessToken: google.issueToken('sub-bob', [...google.grantsOf('sub-bob')]),
      grantedScopes: [...google.grantsOf('sub-bob')],
    });

    expect(await new SubmissionEngine(deps()).submit(coffee)).toMatchObject({ state: 'blocked', error: 'account_mismatch' });
    expect(appends()).toHaveLength(0);
  });
});

describe('retry policy', () => {
  test('a rate-limited attempt backs off on timer runs; foreground resets the backoff', async () => {
    google.failNext({ method: 'POST', pathIncludes: ':append', response: { status: 429, reason: 'RESOURCE_EXHAUSTED' } });
    const engine = new SubmissionEngine(deps());

    expect(await engine.submit(coffee)).toMatchObject({ state: 'pending', error: 'rate_limited' });
    clock += 1_000;
    await engine.processQueue('timer');
    expect(appends()).toHaveLength(1);

    await engine.processQueue('foreground');
    expect(appends()).toHaveLength(2);
    expect(await engine.outcomeOf('uuid-1')).toMatchObject({ kind: 'confirmed' });
  });

  test('schedules the next timed run for unresolved work', async () => {
    const schedule: (number | null)[] = [];
    google.failNext({ method: 'POST', pathIncludes: ':append', response: { status: 503 } });
    const engine = new SubmissionEngine(deps());
    engine.setScheduleListener((at) => schedule.push(at));

    await engine.submit(coffee);

    expect(schedule.at(-1)).toBe(T0 + RECONCILE_SETTLE_MS);
  });
});

describe('totals', () => {
  test('pending, uncertain and blocked submissions are excluded from confirmed spending', async () => {
    const engine = new SubmissionEngine(deps());
    await engine.submit({ ...coffee, amountMinor: 1_000 }); // confirmed
    online = false;
    await engine.submit({ ...coffee, amountMinor: 2_000 }); // pending (offline)
    online = true;
    google.failNext({ method: 'POST', pathIncludes: ':append', response: 'network' });
    await engine.submit({ ...coffee, amountMinor: 4_000 }); // uncertain

    expect((await pending()).map((p) => p.state).sort()).toEqual(['pending', 'uncertain']);
    expect(await sumConfirmedSpending(device.db, scope, null)).toBe(1_000);
  });
});
