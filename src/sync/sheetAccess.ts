import type { AppSettings } from '@/db/appSettings';
import type { SubmissionError } from '@/db/pendingSubmissions';
import type { DataScope, SubmissionErrorCode } from '@/domain/expense';
import { AuthorizationError, type GoogleAuthorizer } from '@/google/authorization';
import { getDriveFile, type DriveFile } from '@/google/drive';
import { GoogleApiError, type FetchLike } from '@/google/http';
import { fetchIdentity } from '@/google/identity';
import { hasDriveFileAccess, REQUIRED_SCOPES } from '@/google/scopes';
import { GoogleSession, ReconnectRequiredError } from '@/google/session';

import { YearTabChangedError } from './yearTabs';

export type SheetAccess =
  | { readonly kind: 'ready'; readonly session: GoogleSession; readonly file: DriveFile }
  /** Needs the user (reconnect, fix the sheet). */
  | { readonly kind: 'blocked'; readonly error: SubmissionError }
  /** Temporary (offline, server, rate limit): try again later. */
  | { readonly kind: 'retry_later'; readonly error: SubmissionError };

export type SheetAccessFailure = Exclude<SheetAccess, { kind: 'ready' }>;

export const MISSING_FILE_REASONS: ReadonlySet<string> = new Set([
  'appNotAuthorizedToFile',
  'insufficientFilePermissions',
  'notFound',
]);

export const err = (code: SubmissionErrorCode, httpStatus: number | null = null): SubmissionError => ({
  code,
  httpStatus,
});

/** Classifies an error raised while reading (never while writing). */
export function accessFailure(error: unknown): SheetAccessFailure {
  if (error instanceof ReconnectRequiredError) return { kind: 'blocked', error: err('auth_required') };
  if (error instanceof YearTabChangedError) return { kind: 'blocked', error: err('sheet_structure_changed') };
  if (error instanceof AuthorizationError) {
    return error.kind === 'network'
      ? { kind: 'retry_later', error: err('offline') }
      : error.kind === 'failed'
        ? { kind: 'retry_later', error: err('server_error') }
        : { kind: 'blocked', error: err('auth_required') };
  }
  if (error instanceof GoogleApiError) {
    const status = error.status;
    if (error.kind === 'network') return { kind: 'retry_later', error: err('offline') };
    if (error.kind === 'timeout') return { kind: 'retry_later', error: err('timeout') };
    if (error.kind === 'rate_limited') return { kind: 'retry_later', error: err('rate_limited', status) };
    if (error.kind === 'unauthorized') return { kind: 'blocked', error: err('auth_required', status) };
    if (error.kind === 'not_found') return { kind: 'blocked', error: err('sheet_missing', status) };
    if (error.kind === 'forbidden') {
      if (error.reason !== null && MISSING_FILE_REASONS.has(error.reason)) {
        return { kind: 'blocked', error: err('sheet_missing', status) };
      }
      return { kind: 'blocked', error: err('auth_required', status) };
    }
    if (error.kind === 'bad_request') return { kind: 'blocked', error: err('invalid_request', status) };
  }
  return { kind: 'retry_later', error: err('server_error') };
}

/**
 * Opens the bound spreadsheet for reading or writing: authorizes silently,
 * checks the token belongs to the bound account and that the file is not
 * trashed. Yearly tabs are checked where they are used (yearTabs.ts).
 */
export async function openSheetAccess(
  services: { readonly authorizer: GoogleAuthorizer; readonly fetch: FetchLike },
  settings: AppSettings,
  scope: DataScope,
): Promise<SheetAccess> {
  try {
    const outcome = await services.authorizer.authorize({
      scopes: REQUIRED_SCOPES,
      accountEmail: settings.googleAccountEmail,
      interactive: false,
      selectAccount: false,
    });
    if (outcome.type !== 'success' || !hasDriveFileAccess(outcome.grantedScopes)) {
      return { kind: 'blocked', error: err('auth_required') };
    }
    const session = new GoogleSession(services, outcome.accessToken, settings.googleAccountEmail);

    // Never use a token for any account other than the one the data belongs to.
    const identity = await fetchIdentity(session);
    if (identity.accountId !== scope.accountId) return { kind: 'blocked', error: err('account_mismatch') };

    const file = await getDriveFile(session, scope.spreadsheetId);
    if (file.trashed) return { kind: 'blocked', error: err('sheet_trashed') };

    return { kind: 'ready', session, file };
  } catch (error) {
    return accessFailure(error);
  }
}

