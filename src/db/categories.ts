import { categoryKey, type CategoryColour, type CategoryUsage, type CustomCategoryInput } from '@/domain/categories';
import type { LocalDate } from '@/domain/dates';
import type { DataScope } from '@/domain/expense';

import type { SqlDatabase } from './sql';

export interface StoredCategory extends CustomCategoryInput {
  readonly createdAt: string;
  /** Spreadsheet whose Categories tab holds this definition; null until backed up. */
  readonly syncedSpreadsheetId: string | null;
}

interface CategoryRow {
  category_id: string;
  name: string;
  icon: string;
  colour: string;
  created_at: string;
  synced_spreadsheet_id: string | null;
}

const toStored = (row: CategoryRow): StoredCategory => ({
  id: row.category_id,
  name: row.name,
  icon: row.icon,
  colour: row.colour,
  createdAt: row.created_at,
  syncedSpreadsheetId: row.synced_spreadsheet_id,
});

const SELECT_CATEGORIES = `SELECT category_id, name, icon, colour, created_at, synced_spreadsheet_id
   FROM categories WHERE account_id = ? ORDER BY created_at, category_id`;

export async function listCustomCategories(db: SqlDatabase, accountId: string): Promise<StoredCategory[]> {
  return (await db.getAll<CategoryRow>(SELECT_CATEGORIES, [accountId])).map(toStored);
}

/** Definitions not yet known to be in this spreadsheet's Categories tab. */
export async function listUnsyncedCategories(db: SqlDatabase, scope: DataScope): Promise<StoredCategory[]> {
  return (await listCustomCategories(db, scope.accountId)).filter((c) => c.syncedSpreadsheetId !== scope.spreadsheetId);
}

export class DuplicateCategoryError extends Error {
  constructor() {
    super('A category with this name already exists');
    this.name = 'DuplicateCategoryError';
  }
}

export interface NewCustomCategory {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly colour: CategoryColour;
  readonly createdAt: string;
}

/** Saves a new category immediately (offline is fine); it is backed up to Sheets later. */
export async function insertCustomCategory(db: SqlDatabase, accountId: string, category: NewCustomCategory): Promise<void> {
  try {
    await db.run(
      `INSERT INTO categories (category_id, account_id, name, name_key, icon, colour, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [category.id, accountId, category.name, categoryKey(category.name), category.icon, category.colour, category.createdAt],
    );
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new DuplicateCategoryError();
    throw error;
  }
}

export async function markCategorySynced(db: SqlDatabase, categoryId: string, spreadsheetId: string, syncedAt: string): Promise<void> {
  await db.run('UPDATE categories SET synced_spreadsheet_id = ?, synced_at = ? WHERE category_id = ?', [
    spreadsheetId,
    syncedAt,
    categoryId,
  ]);
}

/**
 * Merges definitions read from the Categories tab, in one transaction:
 * - a definition already here (same ID) is marked as backed up;
 * - a new one is added, unless a built-in or another definition already uses
 *   its name. If that other definition was created on this phone and never
 *   backed up, the sheet's copy wins (it is the same category, created
 *   earlier elsewhere), so the tab never gets two definitions of one name.
 * Local definitions absent from the sheet are kept for the next backup.
 * Returns how many local rows changed.
 */
export async function mergeRemoteCategories(
  db: SqlDatabase,
  scope: DataScope,
  remote: readonly CustomCategoryInput[],
  reservedKeys: ReadonlySet<string>,
  syncedAt: string,
): Promise<number> {
  let changed = 0;
  await db.transaction(async (tx) => {
    for (const definition of remote) {
      const key = categoryKey(definition.name);
      if (reservedKeys.has(key)) continue;
      const sameId = await tx.getFirst<{ synced_spreadsheet_id: string | null }>(
        'SELECT synced_spreadsheet_id FROM categories WHERE category_id = ?',
        [definition.id],
      );
      if (sameId !== null) {
        if (sameId.synced_spreadsheet_id !== scope.spreadsheetId) {
          await tx.run('UPDATE categories SET synced_spreadsheet_id = ?, synced_at = ? WHERE category_id = ?', [
            scope.spreadsheetId,
            syncedAt,
            definition.id,
          ]);
          changed += 1;
        }
        continue;
      }
      const sameName = await tx.getFirst<{ category_id: string; synced_spreadsheet_id: string | null }>(
        'SELECT category_id, synced_spreadsheet_id FROM categories WHERE account_id = ? AND name_key = ?',
        [scope.accountId, key],
      );
      if (sameName !== null) {
        if (sameName.synced_spreadsheet_id === scope.spreadsheetId) continue;
        await tx.run('DELETE FROM categories WHERE category_id = ?', [sameName.category_id]);
      }
      await tx.run(
        `INSERT INTO categories
           (category_id, account_id, name, name_key, icon, colour, created_at, synced_spreadsheet_id, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [definition.id, scope.accountId, definition.name, key, definition.icon, definition.colour, syncedAt, scope.spreadsheetId, syncedAt],
      );
      changed += 1;
    }
  });
  return changed;
}

export async function setCategoriesMerged(db: SqlDatabase, spreadsheetId: string): Promise<void> {
  await db.run('UPDATE app_settings SET categories_merged_spreadsheet_id = ? WHERE id = ?', [spreadsheetId, 1]);
}

const DISTINCT_LABELS = `SELECT category FROM confirmed_expenses WHERE account_id = ? AND spreadsheet_id = ?
   UNION
   SELECT category FROM pending_submissions WHERE account_id = ? AND spreadsheet_id = ?
   ORDER BY category`;

/** Every category label used by an expense of this scope, confirmed or waiting to be sent. */
export async function listExpenseCategoryLabels(db: SqlDatabase, scope: DataScope): Promise<string[]> {
  const rows = await db.getAll<{ category: string }>(DISTINCT_LABELS, [
    scope.accountId,
    scope.spreadsheetId,
    scope.accountId,
    scope.spreadsheetId,
  ]);
  return rows.map((row) => row.category);
}

// Each expense counts once: a pending row whose ID is already confirmed is skipped.
const USAGE = `SELECT category, COUNT(*) AS n FROM (
     SELECT expense_id AS id, category FROM confirmed_expenses
      WHERE account_id = ? AND spreadsheet_id = ? AND purchase_date >= ? AND purchase_date <= ?
     UNION ALL
     SELECT p.submission_id AS id, p.category FROM pending_submissions p
      WHERE p.account_id = ? AND p.spreadsheet_id = ? AND p.purchase_date >= ? AND p.purchase_date <= ?
        AND NOT EXISTS (SELECT 1 FROM confirmed_expenses c WHERE c.expense_id = p.submission_id)
   ) GROUP BY category`;

/** Number of expenses per category label with a purchase date in [from, to]. */
export async function categoryUsage(db: SqlDatabase, scope: DataScope, from: LocalDate, to: LocalDate): Promise<CategoryUsage[]> {
  const rows = await db.getAll<{ category: string; n: number }>(USAGE, [
    scope.accountId,
    scope.spreadsheetId,
    from,
    to,
    scope.accountId,
    scope.spreadsheetId,
    from,
    to,
  ]);
  return rows.map((row) => ({ category: row.category, count: row.n }));
}
