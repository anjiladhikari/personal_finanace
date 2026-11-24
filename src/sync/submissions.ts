import { dataScopeOf, getAppSettings, isSetupComplete, type AppSettings } from '@/db/appSettings';
import { DuplicateCategoryError, insertCustomCategory, listCustomCategories } from '@/db/categories';
import { notifyCategoriesChanged, notifySettingsChanged, notifySubmissionsChanged } from '@/db/changes';
import { confirmedExpenseExists } from '@/db/confirmedExpenses';
import {
  confirmSubmission,
  getPendingSubmission,
  insertPendingSubmission,
  listPendingSubmissions,
  markInterruptedAsUncertain,
  markSending,
  transitionSubmission,
  unblockSubmissions,
  type PendingSubmission,
  type SubmissionError,
} from '@/db/pendingSubmissions';
import type { SqlDatabase } from '@/db/sql';
import {
  categoryKey,
  colourForName,
  DEFAULT_CATEGORY_ICON,
  iconOrDefault,
  isCategoryColour,
  validateCategoryName,
  type CategoryDefinition,
  type CategoryRegistry,
} from '@/domain/categories';
import type { DataScope, ExpensePayload, SubmissionErrorCode, SubmissionState } from '@/domain/expense';
import { a1Range, HEADER_RANGE_COLUMNS } from '@/domain/sheetContract';
import { parseSheetRow, toSheetRow } from '@/domain/sheetRow';
import {
  ATTEMPT_TIMEOUT_MS,
  BACKOFF_DELAYS_MS,
  backoffDelayMs,
  nextAttemptAt,
  settledAt,
} from '@/domain/submissionPolicy';
import { AuthorizationError, type GoogleAuthorizer } from '@/google/authorization';
import { GoogleApiError, type FetchLike } from '@/google/http';
import { ReconnectRequiredError } from '@/google/session';
import { appendRow, getValues } from '@/google/sheets';

import { syncCategories } from './categorySync';
import { runRefresh, type RefreshFailureCode, type RefreshOutcome, type RefreshProgress } from './refresh';
import { accessFailure, err, openSheetAccess, type SheetAccess } from './sheetAccess';

export type CreateCategoryOutcome =
  | { readonly kind: 'created'; readonly category: CategoryDefinition }
  | { readonly kind: 'duplicate'; readonly existing: CategoryDefinition }
  | { readonly kind: 'invalid'; readonly error: 'blank' | 'too_long' | 'invalid_characters' }
  | { readonly kind: 'failed' };

export type RunTrigger = 'save' | 'startup' | 'foreground' | 'connectivity' | 'manual' | 'timer';

export interface SubmissionDeps {
  readonly db: SqlDatabase;
  readonly authorizer: GoogleAuthorizer;
  readonly fetch: FetchLike;
  readonly isOnline: () => Promise<boolean>;
  readonly newId: () => string;
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** Rows per refresh read request (tests use small chunks). */
  readonly refreshChunkRows?: number;
  /** Pause between refresh validation slices (defaults to yielding to the UI). */
  readonly pause?: () => Promise<void>;
}

export type SyncStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'refreshing'; readonly progress: RefreshProgress | null }
  | { readonly kind: 'failed'; readonly code: RefreshFailureCode };

export type SaveOutcome =
  | { readonly kind: 'confirmed'; readonly submissionId: string }
  /** Written to Sheets, but the local update failed; it is rebuilt from the sheet on the next run. */
  | { readonly kind: 'confirmed_remote_only'; readonly submissionId: string }
  | {
      readonly kind: 'unresolved';
      readonly submissionId: string;
      readonly state: SubmissionState;
      readonly error: SubmissionErrorCode | null;
    }
  /** Nothing was stored; the draft must be kept. */
  | { readonly kind: 'not_saved'; readonly reason: 'not_set_up' | 'storage_failed' };

type SendFailure = { readonly to: SubmissionState; readonly error: SubmissionError; readonly stopRun: boolean };

const BACKOFF_RESET_TRIGGERS: ReadonlySet<RunTrigger> = new Set(['startup', 'foreground', 'connectivity', 'manual']);
const RECONNECT_REASONS = new Set(['insufficientPermissions', 'insufficientScopes', 'authError']);
const ID_COLUMN = 4;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Classifies a failed append. Only responses that prove the row was not
 * written return the submission to pending/blocked; anything that might have
 * reached Google (timeouts, dropped connections, 5xx, unreadable 2xx) is
 * "uncertain" and must be reconciled by Expense ID before another write.
 */
function sendFailure(error: unknown): SendFailure {
  if (error instanceof ReconnectRequiredError) {
    return { to: 'blocked', error: err('auth_required'), stopRun: true };
  }
  if (error instanceof AuthorizationError) {
    // Thrown while refreshing a token after a 401, before the retry was sent.
    return { to: 'pending', error: err(error.kind === 'network' ? 'offline' : 'auth_required'), stopRun: true };
  }
  if (error instanceof GoogleApiError) {
    const status = error.status;
    switch (error.kind) {
      case 'network':
        return { to: 'uncertain', error: err('offline'), stopRun: true };
      case 'timeout':
        return { to: 'uncertain', error: err('timeout'), stopRun: true };
      case 'server':
      case 'invalid_response':
        return { to: 'uncertain', error: err('server_error', status), stopRun: true };
      case 'rate_limited':
        return { to: 'pending', error: err('rate_limited', status), stopRun: true };
      case 'unauthorized':
        return { to: 'blocked', error: err('auth_required', status), stopRun: true };
      case 'not_found':
        return { to: 'blocked', error: err('sheet_missing', status), stopRun: true };
      case 'forbidden':
        return error.reason !== null && RECONNECT_REASONS.has(error.reason)
          ? { to: 'blocked', error: err('auth_required', status), stopRun: true }
          : { to: 'blocked', error: err('sheet_missing', status), stopRun: true };
      case 'bad_request':
        return { to: 'blocked', error: err('invalid_request', status), stopRun: false };
    }
  }
  return { to: 'uncertain', error: err('server_error'), stopRun: true };
}

/**
 * Sends saved expenses to the user's spreadsheet. Every attempt runs through
 * one in-app queue, so two writes are never in flight at once and a
 * submission is never sent twice concurrently.
 */
export class SubmissionEngine {
  private scheduleListener: ((nextRunAt: number | null) => void) | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private rateLimitedUntil = 0;
  /** Written to Sheets in this process, but the local update failed. */
  private readonly remoteOnly = new Set<string>();
  /** A save was confirmed since listeners last heard about settings (its timestamp lives there). */
  private confirmedSinceNotify = false;
  private syncStatus: SyncStatus = { kind: 'idle' };
  private readonly syncListeners = new Set<(status: SyncStatus) => void>();
  private refreshInFlight: Promise<RefreshOutcome> | null = null;

  constructor(private readonly deps: SubmissionDeps) {}

  getSyncStatus(): SyncStatus {
    return this.syncStatus;
  }

  onSyncStatus(listener: (status: SyncStatus) => void): () => void {
    this.syncListeners.add(listener);
    return () => {
      this.syncListeners.delete(listener);
    };
  }

  private setSyncStatus(status: SyncStatus): void {
    this.syncStatus = status;
    for (const listener of [...this.syncListeners]) listener(status);
  }

  /**
   * Rebuilds the confirmed cache from the sheet. It runs in the same queue as
   * submissions, so a refresh never interleaves with a send: a submission
   * confirmed before the refresh starts is in the sheet it reads, and one that
   * starts later commits after it. Concurrent calls share one refresh.
   */
  refresh(): Promise<RefreshOutcome> {
    if (this.refreshInFlight !== null) return this.refreshInFlight;
    this.setSyncStatus({ kind: 'refreshing', progress: null });
    const run = this.serialize(async (): Promise<RefreshOutcome> => {
      try {
        const outcome = await runRefresh(this.deps, (progress) => this.setSyncStatus({ kind: 'refreshing', progress }));
        // A full refresh also restores category definitions (and backs up local ones).
        if (outcome.kind === 'refreshed') await this.syncCategoryDefinitions(true);
        return outcome;
      } catch {
        return { kind: 'failed', code: 'server_error' };
      }
    }).then((outcome) => {
      this.refreshInFlight = null;
      this.setSyncStatus(outcome.kind === 'failed' ? { kind: 'failed', code: outcome.code } : { kind: 'idle' });
      notifySubmissionsChanged();
      if (outcome.kind === 'refreshed') notifySettingsChanged(); // last refresh time
      return outcome;
    });
    this.refreshInFlight = run;
    return run;
  }

  /** Called after every run with the time the next timed run is due (or null). */
  setScheduleListener(listener: ((nextRunAt: number | null) => void) | null): void {
    this.scheduleListener = listener;
  }

  /** Steps 2–6 for a validated expense. Each call is a distinct purchase with its own UUID. */
  async submit(payload: ExpensePayload): Promise<SaveOutcome> {
    let scope: DataScope | null;
    try {
      const settings = await getAppSettings(this.deps.db);
      scope = isSetupComplete(settings) ? dataScopeOf(settings) : null;
    } catch {
      return { kind: 'not_saved', reason: 'storage_failed' };
    }
    if (scope === null) return { kind: 'not_saved', reason: 'not_set_up' };

    const submissionId = this.deps.newId();
    try {
      await insertPendingSubmission(this.deps.db, scope, {
        ...payload,
        submissionId,
        createdAt: iso(this.deps.now()),
      });
    } catch {
      return { kind: 'not_saved', reason: 'storage_failed' };
    }
    notifySubmissionsChanged();

    await this.serialize(() => this.run('save', submissionId));
    return this.outcomeOf(submissionId);
  }

  /** "Retry now": actionable failures become pending and everything is tried immediately. */
  async retry(submissionId?: string): Promise<SaveOutcome | null> {
    await this.serialize(async () => {
      const settings = await getAppSettings(this.deps.db);
      const scope = dataScopeOf(settings);
      if (scope !== null && (await unblockSubmissions(this.deps.db, scope)) > 0) notifySubmissionsChanged();
      return this.run('manual', submissionId);
    });
    return submissionId === undefined ? null : this.outcomeOf(submissionId);
  }

  /**
   * Creates a category on this phone immediately (works offline), then asks
   * for its definition to be backed up to the Categories tab. Never saves an
   * expense. `registry` is the caller's current view, used to reject names
   * that already exist; the database also refuses duplicates.
   */
  async createCategory(input: string, registry: CategoryRegistry): Promise<CreateCategoryOutcome> {
    const validation = validateCategoryName(input, registry);
    if (!validation.ok) {
      return validation.error === 'duplicate'
        ? { kind: 'duplicate', existing: validation.existing }
        : { kind: 'invalid', error: validation.error };
    }
    let accountId: string | null = null;
    try {
      const settings = await getAppSettings(this.deps.db);
      const scope = dataScopeOf(settings);
      if (!isSetupComplete(settings) || scope === null) return { kind: 'failed' };
      accountId = scope.accountId;
      const category: CategoryDefinition = {
        id: `custom-${this.deps.newId()}`,
        name: validation.name,
        icon: DEFAULT_CATEGORY_ICON,
        colour: colourForName(validation.name),
        source: 'custom',
      };
      await insertCustomCategory(this.deps.db, accountId, { ...category, createdAt: iso(this.deps.now()) });
      notifyCategoriesChanged();
      void this.syncCategories();
      return { kind: 'created', category };
    } catch (error) {
      if (error instanceof DuplicateCategoryError && accountId !== null) {
        // The caller's view was out of date: name the definition already stored.
        const stored = (await listCustomCategories(this.deps.db, accountId)).find(
          (c) => categoryKey(c.name) === categoryKey(validation.name),
        );
        if (stored === undefined) return { kind: 'failed' };
        const existing: CategoryDefinition = {
          id: stored.id,
          name: stored.name,
          icon: iconOrDefault(stored.icon),
          colour: isCategoryColour(stored.colour) ? stored.colour : colourForName(stored.name),
          source: 'custom',
        };
        return { kind: 'duplicate', existing };
      }
      return { kind: 'failed' };
    }
  }

  /**
   * Backs up category definitions created on this phone; with `restore`
   * (after connecting Google) also brings back ones saved from other installs.
   */
  syncCategories(options: { readonly restore?: boolean } = {}): Promise<void> {
    return this.serialize(() => this.syncCategoryDefinitions(options.restore === true));
  }

  processQueue(trigger: RunTrigger): Promise<void> {
    return this.serialize(() => this.run(trigger)).then(() => undefined);
  }

  async outcomeOf(submissionId: string): Promise<SaveOutcome> {
    const pending = await getPendingSubmission(this.deps.db, submissionId);
    if (pending === null) {
      this.remoteOnly.delete(submissionId);
      return (await confirmedExpenseExists(this.deps.db, submissionId))
        ? { kind: 'confirmed', submissionId }
        : { kind: 'not_saved', reason: 'storage_failed' };
    }
    if (this.remoteOnly.has(submissionId)) return { kind: 'confirmed_remote_only', submissionId };
    return { kind: 'unresolved', submissionId, state: pending.state, error: pending.lastError?.code ?? null };
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async run(trigger: RunTrigger, focusId?: string): Promise<void> {
    let nextRunAt: number | null = null;
    try {
      nextRunAt = await this.runSteps(trigger, focusId);
      // Category definitions travel separately from expense rows; a failure
      // here never affects saving, and is retried on the next run.
      await this.syncCategoryDefinitions(false);
    } catch {
      // Unexpected local failure (e.g. storage). Nothing is lost: rows stay as persisted.
      nextRunAt = this.deps.now() + (BACKOFF_DELAYS_MS[1] ?? 30_000);
    } finally {
      notifySubmissionsChanged();
      if (this.confirmedSinceNotify) {
        this.confirmedSinceNotify = false;
        notifySettingsChanged(); // last confirmed save time
      }
    }
    this.scheduleListener?.(nextRunAt);
  }

  private async syncCategoryDefinitions(force: boolean): Promise<void> {
    try {
      const outcome = await syncCategories(this.deps, { force });
      if (outcome.kind === 'synced') notifyCategoriesChanged();
    } catch {
      // Local storage problem: definitions stay waiting and are retried.
    }
  }

  private async runSteps(trigger: RunTrigger, focusId?: string): Promise<number | null> {
    const { db } = this.deps;
    // Runs are serialized, so nothing is in flight now: 'sending' rows were interrupted.
    await markInterruptedAsUncertain(db);

    const settings = await getAppSettings(db);
    const scope = dataScopeOf(settings);
    if (!isSetupComplete(settings) || scope === null) return null;

    const items = await listPendingSubmissions(db, scope);
    const now = this.deps.now();
    const resetBackoff = BACKOFF_RESET_TRIGGERS.has(trigger);
    const isDue = (s: PendingSubmission) =>
      s.state === 'pending' &&
      (s.submissionId === focusId ||
        resetBackoff ||
        ((nextAttemptAt(s) ?? 0) <= now && this.rateLimitedUntil <= now));

    if (!items.some((s) => s.state === 'uncertain' || isDue(s))) return this.nextRunAt(items);

    if (!(await this.deps.isOnline())) {
      await this.setErrors(items.filter(isDue), 'pending', err('offline'));
      return null; // the connectivity trigger resumes
    }

    const preflight = await openSheetAccess(this.deps, settings, scope);
    if (preflight.kind !== 'ready') {
      for (const item of items) {
        if (item.state === 'pending' && preflight.kind === 'blocked') {
          await transitionSubmission(db, item.submissionId, 'pending', 'blocked', preflight.error);
        } else if (item.state === 'pending' || item.state === 'uncertain') {
          // An uncertain row is never blocked: it must be reconciled before any new write.
          await transitionSubmission(db, item.submissionId, item.state, item.state, preflight.error);
        }
      }
      return preflight.kind === 'blocked' ? null : now + (BACKOFF_DELAYS_MS[1] ?? 30_000);
    }

    const resendable = await this.reconcile(preflight, settings, scope, items);
    if (resendable === null) return this.nextRunAt(await listPendingSubmissions(db, scope));

    for (const item of await listPendingSubmissions(db, scope)) {
      if (item.state !== 'pending' || !(isDue(item) || resendable.has(item.submissionId))) continue;
      const failure = await this.send(preflight, settings, scope, item);
      if (failure?.stopRun) break;
    }
    return this.nextRunAt(await listPendingSubmissions(db, scope));
  }

  /**
   * Looks up every uncertain submission's Expense ID in the sheet. Found →
   * confirmed from the remote record. Absent → still uncertain until the
   * settle window has passed; after that it may be re-sent with the same ID.
   * Returns the IDs that may be re-sent now, or null if the read failed.
   */
  private async reconcile(
    ready: Extract<SheetAccess, { kind: 'ready' }>,
    settings: AppSettings,
    scope: DataScope,
    items: readonly PendingSubmission[],
  ): Promise<Set<string> | null> {
    const resendable = new Set<string>();
    const uncertain = items.filter((s) => s.state === 'uncertain');
    if (uncertain.length === 0) return resendable;

    let rows: unknown[][];
    try {
      rows = await getValues(ready.session, scope.spreadsheetId, a1Range(ready.tab.title, 'A2:E'));
    } catch (error) {
      const failure = accessFailure(error);
      for (const item of uncertain) {
        await transitionSubmission(this.deps.db, item.submissionId, 'uncertain', 'uncertain', failure.error);
      }
      return null;
    }

    const now = this.deps.now();
    for (const item of uncertain) {
      const match = rows.find((row) => String(row[ID_COLUMN] ?? '').trim() === item.submissionId);
      if (match !== undefined) {
        const remote = parseSheetRow(match, settings.currency.minorUnits);
        // Rebuild local state from what Google actually holds.
        await confirmSubmission(this.deps.db, scope, item.submissionId, remote ?? item, iso(this.deps.now()));
        this.confirmedSinceNotify = true;
        this.remoteOnly.delete(item.submissionId);
      } else if (now >= settledAt(item.lastAttemptAt)) {
        if (await transitionSubmission(this.deps.db, item.submissionId, 'uncertain', 'pending', null)) {
          resendable.add(item.submissionId);
        }
      }
    }
    return resendable;
  }

  private async send(
    ready: Extract<SheetAccess, { kind: 'ready' }>,
    settings: AppSettings,
    scope: DataScope,
    item: PendingSubmission,
  ): Promise<SendFailure | null> {
    const { db } = this.deps;
    if (!(await markSending(db, item.submissionId, iso(this.deps.now())))) return null;
    notifySubmissionsChanged();

    try {
      await appendRow(
        ready.session,
        scope.spreadsheetId,
        a1Range(ready.tab.title, HEADER_RANGE_COLUMNS),
        toSheetRow(item.submissionId, item, settings.currency.minorUnits),
        ATTEMPT_TIMEOUT_MS,
      );
    } catch (error) {
      const failure = sendFailure(error);
      await transitionSubmission(db, item.submissionId, 'sending', failure.to, failure.error);
      if (failure.error.code === 'rate_limited') {
        const retryAfter = error instanceof GoogleApiError ? (error.retryAfterMs ?? 0) : 0;
        this.rateLimitedUntil =
          this.deps.now() + Math.max(retryAfter, backoffDelayMs(item.submissionId, item.attemptCount + 1));
      }
      return failure;
    }

    // Google confirmed the append. Complete it locally in one transaction.
    try {
      await confirmSubmission(db, scope, item.submissionId, item, iso(this.deps.now()));
      this.confirmedSinceNotify = true;
    } catch {
      // The row stays 'sending'; the next run treats it as uncertain, finds the
      // Expense ID in the sheet and rebuilds the local record from it.
      this.remoteOnly.add(item.submissionId);
    }
    return null;
  }

  private async setErrors(items: readonly PendingSubmission[], state: SubmissionState, error: SubmissionError) {
    for (const item of items) {
      await transitionSubmission(this.deps.db, item.submissionId, state, state, error);
    }
  }

  private nextRunAt(items: readonly PendingSubmission[]): number | null {
    const now = this.deps.now();
    const soon = now + (BACKOFF_DELAYS_MS[0] ?? 10_000);
    const times: number[] = [];
    for (const item of items) {
      if (item.state === 'pending') {
        if (item.lastError?.code === 'offline') continue;
        times.push(Math.max(nextAttemptAt(item) ?? soon, this.rateLimitedUntil));
      } else if (item.state === 'uncertain') {
        times.push(Math.max(settledAt(item.lastAttemptAt), soon));
      } else if (item.state === 'sending') {
        times.push(soon);
      }
    }
    return times.length === 0 ? null : Math.min(...times);
  }
}
