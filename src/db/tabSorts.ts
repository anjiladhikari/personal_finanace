import type { SqlDatabase } from './sql';

/** Records that a yearly tab needs sorting (idempotent). */
export async function markTabSortNeeded(db: SqlDatabase, spreadsheetId: string, tabTitle: string): Promise<void> {
  await db.run('INSERT OR IGNORE INTO pending_tab_sorts (spreadsheet_id, tab_title) VALUES (?, ?)', [spreadsheetId, tabTitle]);
}

export async function clearTabSort(db: SqlDatabase, spreadsheetId: string, tabTitle: string): Promise<void> {
  await db.run('DELETE FROM pending_tab_sorts WHERE spreadsheet_id = ? AND tab_title = ?', [spreadsheetId, tabTitle]);
}

/** Yearly tabs of this spreadsheet still waiting to be sorted. */
export async function listPendingTabSorts(db: SqlDatabase, spreadsheetId: string): Promise<string[]> {
  const rows = await db.getAll<{ tab_title: string }>(
    'SELECT tab_title FROM pending_tab_sorts WHERE spreadsheet_id = ? ORDER BY tab_title',
    [spreadsheetId],
  );
  return rows.map((row) => row.tab_title);
}
