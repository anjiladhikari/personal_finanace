import { dataScopeOf, getAppSettings, isSetupComplete } from '@/db/appSettings';
import { replaceLedgerCache } from '@/db/ledgerCache';
import type { SqlDatabase } from '@/db/sql';
import type { SubmissionErrorCode } from '@/domain/expense';
import { buildLedger, affectsTotals, type SheetRowInput } from '@/domain/ledger';
import { a1Range } from '@/domain/sheetContract';
import type { GoogleAuthorizer } from '@/google/authorization';
import { getDriveFile, type DriveFile } from '@/google/drive';
import type { FetchLike } from '@/google/http';
import type { GoogleSession } from '@/google/session';
import { getValues } from '@/google/sheets';

import { accessFailure, openSheetAccess } from './sheetAccess';

/** Rows per read request (provisional). Columns are always A:E only. */
export const REFRESH_CHUNK_ROWS = 2000;
/** A refresh that sees the sheet change while reading starts again, at most this many times in total. */
export const MAX_REFRESH_ATTEMPTS = 3;

export type RefreshFailureCode = SubmissionErrorCode | 'changed_during_refresh';

export type RefreshOutcome =
  | { readonly kind: 'refreshed'; readonly expenseCount: number; readonly excludedRowCount: number; readonly syncedAt: string }
  | { readonly kind: 'failed'; readonly code: RefreshFailureCode }
  | { readonly kind: 'not_set_up' };

export interface RefreshProgress {
  readonly attempt: number;
  readonly rowsRead: number;
  /** Rows in the sheet grid (upper bound), when known. */
  readonly totalRows: number | null;
}

export interface RefreshDeps {
  readonly db: SqlDatabase;
  readonly authorizer: GoogleAuthorizer;
  readonly fetch: FetchLike;
  readonly isOnline: () => Promise<boolean>;
  readonly now: () => number;
  readonly refreshChunkRows?: number;
}

function unchanged(before: DriveFile, after: DriveFile): boolean {
  return before.version === after.version && before.modifiedTime === after.modifiedTime;
}

/**
 * Reads rows 2..last of the Expenses tab in bounded requests. When the grid
 * size is unknown, reading stops at the first completely empty chunk.
 */
async function readRows(
  session: GoogleSession,
  spreadsheetId: string,
  tabTitle: string,
  rowCount: number | null,
  chunkRows: number,
  onChunk: (rowsRead: number) => void,
): Promise<SheetRowInput[]> {
  const rows: SheetRowInput[] = [];
  for (let start = 2; rowCount === null || start <= rowCount; start += chunkRows) {
    const end = rowCount === null ? start + chunkRows - 1 : Math.min(start + chunkRows - 1, rowCount);
    const values = await getValues(session, spreadsheetId, a1Range(tabTitle, `A${start}:E${end}`));
    values.forEach((cells, offset) => rows.push({ rowNumber: start + offset, cells }));
    onChunk(end - 1);
    if (rowCount === null && values.length === 0) break;
  }
  return rows;
}

/**
 * Rebuilds the confirmed cache from the sheet. Nothing local changes unless
 * the complete sheet was read without it changing in between, validated, and
 * committed in one transaction; otherwise the previous cache stays as it was.
 */
export async function runRefresh(
  deps: RefreshDeps,
  onProgress: (progress: RefreshProgress) => void,
): Promise<RefreshOutcome> {
  const settings = await getAppSettings(deps.db);
  const scope = dataScopeOf(settings);
  if (!isSetupComplete(settings) || scope === null) return { kind: 'not_set_up' };
  if (!(await deps.isOnline())) return { kind: 'failed', code: 'offline' };

  const chunkRows = deps.refreshChunkRows ?? REFRESH_CHUNK_ROWS;
  for (let attempt = 1; attempt <= MAX_REFRESH_ATTEMPTS; attempt += 1) {
    const access = await openSheetAccess(deps, settings, scope);
    if (access.kind !== 'ready') return { kind: 'failed', code: access.error.code };

    let rows: SheetRowInput[];
    let after: DriveFile;
    try {
      onProgress({ attempt, rowsRead: 0, totalRows: access.tab.rowCount });
      rows = await readRows(access.session, scope.spreadsheetId, access.tab.title, access.tab.rowCount, chunkRows, (rowsRead) =>
        onProgress({ attempt, rowsRead, totalRows: access.tab.rowCount }),
      );
      after = await getDriveFile(access.session, scope.spreadsheetId);
    } catch (error) {
      return { kind: 'failed', code: accessFailure(error).error.code };
    }

    // Rows can shift between chunk requests if the sheet is edited meanwhile.
    // Our own writes cannot happen now (refresh holds the sync queue), so a
    // change means someone edited the sheet: read it again from the start.
    if (!unchanged(access.file, after)) continue;

    const ledger = buildLedger(rows, settings.currency.minorUnits);
    const syncedAt = new Date(deps.now()).toISOString();
    const committed = await replaceLedgerCache(deps.db, scope, ledger, syncedAt);
    if (committed === 'binding_changed') return { kind: 'failed', code: 'account_mismatch' };
    return {
      kind: 'refreshed',
      expenseCount: ledger.expenses.length,
      excludedRowCount: ledger.issues.filter((issue) => affectsTotals(issue.kind)).length,
      syncedAt,
    };
  }
  return { kind: 'failed', code: 'changed_during_refresh' };
}
