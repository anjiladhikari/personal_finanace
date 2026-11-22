import { bindGoogleAccount, bindSpreadsheet, getAppSettings } from '@/db/appSettings';
import { notifySettingsChanged } from '@/db/changes';
import { countPendingSubmissions } from '@/db/pendingSubmissions';
import type { SqlDatabase } from '@/db/sql';
import { logDiagnostic } from '@/diagnostics/log';
import { initialAppProperties, isTaggedExpensesFile, type HeaderProblem } from '@/domain/sheetContract';
import { AuthorizationError, type GoogleAuthorizer } from '@/google/authorization';
import {
  createTaggedSpreadsheet,
  findTaggedSpreadsheets,
  getDriveFile,
  setAppProperties,
  type DriveFile,
} from '@/google/drive';
import { GoogleApiError, type FetchLike } from '@/google/http';
import { fetchIdentity } from '@/google/identity';
import { hasDriveFileAccess, REQUIRED_SCOPES } from '@/google/scopes';
import { GoogleSession, ReconnectRequiredError } from '@/google/session';
import { ensureExpensesTab } from '@/google/spreadsheet';

export interface SpreadsheetCandidate {
  readonly id: string;
  readonly name: string;
  readonly createdTime: string | null;
  readonly modifiedTime: string | null;
}

/** Every outcome the Connect / Check connection actions can produce. */
export type ConnectionState =
  | { readonly kind: 'ready'; readonly accountEmail: string; readonly spreadsheetId: string; readonly created: boolean }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'reconnect_required' }
  | { readonly kind: 'permission_missing' }
  | {
      readonly kind: 'account_mismatch';
      readonly boundEmail: string | null;
      readonly selectedEmail: string;
      readonly pendingCount: number;
    }
  | { readonly kind: 'choose_spreadsheet'; readonly candidates: readonly SpreadsheetCandidate[] }
  | { readonly kind: 'spreadsheet_trashed' }
  | { readonly kind: 'spreadsheet_missing' }
  | { readonly kind: 'schema_invalid'; readonly problem: HeaderProblem }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'misconfigured' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'failed' };

export type ConnectionStateKind = ConnectionState['kind'];

export interface ConnectionRequest {
  /** May show Google's account chooser / consent screens. */
  readonly interactive: boolean;
  /** Show the account chooser even if an account is remembered. */
  readonly selectAccount?: boolean;
  /** Authorize this account instead of the remembered one. */
  readonly accountEmail?: string;
  /** The user confirmed replacing the bound account (allowed only with no pending expenses). */
  readonly confirmAccountSwitch?: boolean;
  /** The user picked this file from a choose_spreadsheet state. */
  readonly chosenSpreadsheetId?: string;
  /** The user asked for a fresh "My Expenses" file (missing/trashed recovery). */
  readonly createNewSpreadsheet?: boolean;
}

export interface ConnectionDeps {
  readonly db: SqlDatabase;
  readonly authorizer: GoogleAuthorizer;
  readonly fetch: FetchLike;
}

type FileResolution =
  | { readonly kind: 'file'; readonly file: DriveFile; readonly created: boolean }
  | { readonly kind: 'state'; readonly state: ConnectionState };

const MISSING_FILE_REASONS = new Set(['appNotAuthorizedToFile', 'insufficientFilePermissions', 'notFound']);
const RECONNECT_REASONS = new Set(['insufficientPermissions', 'insufficientScopes', 'authError']);
// The Drive or Sheets API is not enabled in the app's Google Cloud project.
const MISCONFIGURED_REASONS = new Set(['accessNotConfigured', 'SERVICE_DISABLED']);

function toCandidate(file: DriveFile): SpreadsheetCandidate {
  return { id: file.id, name: file.name, createdTime: file.createdTime, modifiedTime: file.modifiedTime };
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof GoogleApiError &&
    (error.kind === 'not_found' ||
      (error.kind === 'forbidden' && error.reason !== null && MISSING_FILE_REASONS.has(error.reason)))
  );
}

async function resolveSpreadsheet(
  session: GoogleSession,
  boundSpreadsheetId: string | null,
  request: ConnectionRequest,
): Promise<FileResolution> {
  if (request.createNewSpreadsheet) {
    return { kind: 'file', file: await createTaggedSpreadsheet(session), created: true };
  }

  if (request.chosenSpreadsheetId !== undefined) {
    const candidates = await findTaggedSpreadsheets(session, { trashed: false });
    const chosen = candidates.find((file) => file.id === request.chosenSpreadsheetId);
    if (chosen === undefined) {
      return candidates.length > 1
        ? { kind: 'state', state: { kind: 'choose_spreadsheet', candidates: candidates.map(toCandidate) } }
        : { kind: 'state', state: { kind: 'spreadsheet_missing' } };
    }
    return { kind: 'file', file: chosen, created: false };
  }

  if (boundSpreadsheetId !== null) {
    let file: DriveFile;
    try {
      file = await getDriveFile(session, boundSpreadsheetId);
    } catch (error) {
      if (isMissingFileError(error)) return { kind: 'state', state: { kind: 'spreadsheet_missing' } };
      throw error;
    }
    if (file.trashed) return { kind: 'state', state: { kind: 'spreadsheet_trashed' } };
    return { kind: 'file', file, created: false };
  }

  // Nothing bound on this phone: first run or reinstall. Look before creating.
  const candidates = await findTaggedSpreadsheets(session, { trashed: false });
  const [only] = candidates;
  if (candidates.length > 1) {
    return { kind: 'state', state: { kind: 'choose_spreadsheet', candidates: candidates.map(toCandidate) } };
  }
  if (only !== undefined) return { kind: 'file', file: only, created: false };

  const trashed = await findTaggedSpreadsheets(session, { trashed: true });
  if (trashed.length > 0) return { kind: 'state', state: { kind: 'spreadsheet_trashed' } };

  return { kind: 'file', file: await createTaggedSpreadsheet(session), created: true };
}

function stateForError(error: unknown): ConnectionState {
  if (error instanceof ReconnectRequiredError) return { kind: 'reconnect_required' };
  if (error instanceof AuthorizationError) {
    if (error.kind === 'unavailable') return { kind: 'unavailable' };
    if (error.kind === 'network') return { kind: 'offline' };
    if (error.kind === 'misconfigured') return { kind: 'misconfigured' };
    return { kind: 'failed' };
  }
  if (error instanceof GoogleApiError) {
    if (error.kind === 'network' || error.kind === 'timeout') return { kind: 'offline' };
    if (error.kind === 'unauthorized') return { kind: 'reconnect_required' };
    if (error.kind === 'forbidden' && error.reason !== null && RECONNECT_REASONS.has(error.reason)) {
      return { kind: 'reconnect_required' };
    }
    if (error.kind === 'forbidden' && error.reason !== null && MISCONFIGURED_REASONS.has(error.reason)) {
      return { kind: 'misconfigured' };
    }
  }
  return { kind: 'failed' };
}

async function connect(deps: ConnectionDeps, request: ConnectionRequest): Promise<ConnectionState> {
  if (!deps.authorizer.available) return { kind: 'unavailable' };
  const settings = await getAppSettings(deps.db);
  const selectAccount = request.selectAccount === true;

  const outcome = await deps.authorizer.authorize({
    scopes: REQUIRED_SCOPES,
    accountEmail: selectAccount ? null : (request.accountEmail ?? settings.googleAccountEmail),
    interactive: request.interactive,
    selectAccount,
  });
  if (outcome.type === 'cancelled') return { kind: 'cancelled' };
  if (outcome.type === 'needs_user_interaction') return { kind: 'reconnect_required' };
  if (!hasDriveFileAccess(outcome.grantedScopes)) return { kind: 'permission_missing' };

  const session = new GoogleSession(deps, outcome.accessToken, settings.googleAccountEmail);
  const identity = await fetchIdentity(session);
  session.setAccountEmail(identity.email);

  // Account binding. Pending expenses never follow a different account.
  const boundId = settings.googleAccountId;
  const switching = boundId !== null && boundId !== identity.accountId;
  if (switching) {
    const pendingCount = await countPendingSubmissions(deps.db, boundId);
    if (pendingCount > 0 || request.confirmAccountSwitch !== true) {
      return {
        kind: 'account_mismatch',
        boundEmail: settings.googleAccountEmail,
        selectedEmail: identity.email,
        pendingCount,
      };
    }
  }
  await bindGoogleAccount(deps.db, identity, { switchAccount: switching });
  notifySettingsChanged();

  // After a switch the old spreadsheet binding was cleared.
  const boundSpreadsheetId = switching ? null : settings.spreadsheetId;
  const resolution = await resolveSpreadsheet(session, boundSpreadsheetId, request);
  if (resolution.kind === 'state') return resolution.state;
  const { created } = resolution;
  let { file } = resolution;

  if (!isTaggedExpensesFile(file.appProperties)) {
    // Fallback if the create request's app properties were not applied.
    file = await setAppProperties(session, file.id, initialAppProperties());
    if (!isTaggedExpensesFile(file.appProperties)) return { kind: 'failed' };
  }

  const boundSheetId = file.id === boundSpreadsheetId ? settings.expensesSheetId : null;
  const tab = await ensureExpensesTab(session, file, boundSheetId);
  if (tab.kind === 'invalid') return { kind: 'schema_invalid', problem: tab.problem };

  await bindSpreadsheet(deps.db, {
    accountId: identity.accountId,
    spreadsheetId: file.id,
    expensesSheetId: tab.sheetId,
  });
  notifySettingsChanged();
  return { kind: 'ready', accountEmail: identity.email, spreadsheetId: file.id, created };
}

/**
 * Connects Google and provisions the expense spreadsheet. Idempotent: running
 * it again re-validates and reuses everything already set up.
 */
export async function connectGoogle(
  deps: ConnectionDeps,
  request: ConnectionRequest,
): Promise<ConnectionState> {
  let state: ConnectionState;
  try {
    state = await connect(deps, request);
  } catch (error) {
    state = stateForError(error);
  }
  logDiagnostic('google.connection_result', {
    result: state.kind,
    created: state.kind === 'ready' && state.created,
  });
  return state;
}
