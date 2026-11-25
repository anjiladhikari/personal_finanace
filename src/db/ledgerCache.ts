import type { DataScope } from '@/domain/expense';
import type { Ledger, LedgerIssueKind } from '@/domain/ledger';

import type { SqlDatabase, SqlValue } from './sql';

// Multi-row statements keep large refreshes fast while staying well under
// SQLite's bound-parameter limit (7 columns x 100 rows = 700 parameters).
const ROWS_PER_INSERT = 100;
const IDS_PER_DELETE = 500;

function placeholders(rowCount: number, columnCount: number): string {
  const row = `(${new Array<string>(columnCount).fill('?').join(', ')})`;
  return new Array<string>(rowCount).fill(row).join(', ');
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function insertExpensesSql(rowCount: number): string {
  return `INSERT INTO confirmed_expenses
    (expense_id, account_id, spreadsheet_id, purchase_date, description, amount_minor, category)
    VALUES ${placeholders(rowCount, 7)}`;
}

function insertIssuesSql(rowCount: number): string {
  return `INSERT INTO sheet_issues (account_id, spreadsheet_id, tab_title, row_number, kind, expense_id)
    VALUES ${placeholders(rowCount, 6)}`;
}

function deletePendingSql(idCount: number): string {
  return `DELETE FROM pending_submissions
    WHERE account_id = ? AND spreadsheet_id = ? AND submission_id IN (${new Array<string>(idCount).fill('?').join(', ')})`;
}

export type ReplaceResult = 'replaced' | 'binding_changed';

/**
 * Replaces the confirmed cache for one scope with a complete, validated
 * ledger, in a single exclusive transaction. If anything fails, the previous
 * cache is untouched. Pending submissions whose Expense ID is already in the
 * sheet are completed (they were written). The binding is re-checked inside
 * the transaction so a refresh for a stale account/spreadsheet never commits.
 */
export async function replaceLedgerCache(
  db: SqlDatabase,
  scope: DataScope,
  ledger: Ledger,
  syncedAt: string,
): Promise<ReplaceResult> {
  let result: ReplaceResult = 'replaced';
  await db.transaction(async (tx) => {
    const binding = await tx.getFirst<{ google_account_id: string | null; spreadsheet_id: string | null }>(
      'SELECT google_account_id, spreadsheet_id FROM app_settings WHERE id = ?',
      [1],
    );
    if (binding?.google_account_id !== scope.accountId || binding.spreadsheet_id !== scope.spreadsheetId) {
      result = 'binding_changed';
      return;
    }

    await tx.run('DELETE FROM confirmed_expenses WHERE account_id = ? AND spreadsheet_id = ?', [
      scope.accountId,
      scope.spreadsheetId,
    ]);
    for (const batch of chunks(ledger.expenses, ROWS_PER_INSERT)) {
      const params: SqlValue[] = [];
      for (const e of batch) {
        params.push(e.expenseId, scope.accountId, scope.spreadsheetId, e.purchaseDate, e.description, e.amountMinor, e.category);
      }
      await tx.run(insertExpensesSql(batch.length), params);
    }

    await tx.run('DELETE FROM sheet_issues WHERE account_id = ? AND spreadsheet_id = ?', [
      scope.accountId,
      scope.spreadsheetId,
    ]);
    for (const batch of chunks(ledger.issues, ROWS_PER_INSERT)) {
      const params: SqlValue[] = [];
      for (const issue of batch) {
        params.push(scope.accountId, scope.spreadsheetId, issue.tab, issue.rowNumber, issue.kind, issue.expenseId);
      }
      await tx.run(insertIssuesSql(batch.length), params);
    }

    for (const batch of chunks([...ledger.idsInSheet], IDS_PER_DELETE)) {
      await tx.run(deletePendingSql(batch.length), [scope.accountId, scope.spreadsheetId, ...batch]);
    }

    await tx.run('UPDATE app_settings SET last_successful_sync_at = ? WHERE id = ?', [syncedAt, 1]);
  });
  return result;
}

export interface StoredSheetIssue {
  /** The yearly tab, e.g. "2026". */
  readonly tab: string;
  readonly rowNumber: number;
  readonly kind: LedgerIssueKind;
  readonly expenseId: string | null;
}

export async function listSheetIssues(db: SqlDatabase, scope: DataScope): Promise<StoredSheetIssue[]> {
  const rows = await db.getAll<{ tab_title: string; row_number: number; kind: LedgerIssueKind; expense_id: string | null }>(
    `SELECT tab_title, row_number, kind, expense_id FROM sheet_issues
     WHERE account_id = ? AND spreadsheet_id = ? ORDER BY tab_title, row_number`,
    [scope.accountId, scope.spreadsheetId],
  );
  return rows.map((row) => ({ tab: row.tab_title, rowNumber: row.row_number, kind: row.kind, expenseId: row.expense_id }));
}

export async function countConfirmedExpenses(db: SqlDatabase, scope: DataScope): Promise<number> {
  const row = await db.getFirst<{ n: number }>(
    'SELECT COUNT(*) AS n FROM confirmed_expenses WHERE account_id = ? AND spreadsheet_id = ?',
    [scope.accountId, scope.spreadsheetId],
  );
  return row?.n ?? 0;
}
