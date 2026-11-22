import { parseLocalDate, type DateRange } from '@/domain/dates';
import {
  isValidDataScope,
  isValidExpensePayload,
  type DataScope,
  type ExpensePayload,
} from '@/domain/expense';

import type { SqlDatabase } from './sql';

export interface ConfirmedExpense extends ExpensePayload {
  readonly expenseId: string;
}

interface ConfirmedExpenseRow {
  expense_id: string;
  purchase_date: string;
  description: string;
  amount_minor: number;
  category: string;
}

function toConfirmedExpense(row: ConfirmedExpenseRow): ConfirmedExpense {
  const purchaseDate = parseLocalDate(row.purchase_date);
  if (purchaseDate === null) throw new Error('Corrupt confirmed expense row');
  return {
    expenseId: row.expense_id,
    purchaseDate,
    description: row.description,
    amountMinor: row.amount_minor,
    category: row.category,
  };
}

export async function insertConfirmedExpense(
  db: SqlDatabase,
  scope: DataScope,
  expense: ConfirmedExpense,
): Promise<void> {
  if (!isValidDataScope(scope) || !isValidExpensePayload(expense)) {
    throw new Error('Invalid confirmed expense');
  }
  await db.run(
    `INSERT INTO confirmed_expenses
       (expense_id, account_id, spreadsheet_id, purchase_date, description, amount_minor, category)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      expense.expenseId,
      scope.accountId,
      scope.spreadsheetId,
      expense.purchaseDate,
      expense.description,
      expense.amountMinor,
      expense.category,
    ],
  );
}

/**
 * Confirmed expenses for one scope, optionally limited to a half-open date
 * range (start <= purchase_date < endExclusive). `null` means all time.
 */
export async function listConfirmedExpenses(
  db: SqlDatabase,
  scope: DataScope,
  range: DateRange | null,
): Promise<ConfirmedExpense[]> {
  const rows = await db.getAll<ConfirmedExpenseRow>(
    `SELECT expense_id, purchase_date, description, amount_minor, category
     FROM confirmed_expenses
     WHERE account_id = ? AND spreadsheet_id = ?
       AND purchase_date >= ? AND purchase_date < ?
     ORDER BY purchase_date, expense_id`,
    [
      scope.accountId,
      scope.spreadsheetId,
      range?.start ?? '0000-01-01',
      range?.endExclusive ?? '9999-12-31',
    ],
  );
  return rows.map(toConfirmedExpense);
}
