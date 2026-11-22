import { isLocalDate, type LocalDate } from './dates';

/** The fields a user enters for one expense. Amounts are minor units. */
export interface ExpensePayload {
  readonly purchaseDate: LocalDate;
  readonly description: string;
  readonly amountMinor: number;
  readonly category: string;
}

/**
 * The Google account and spreadsheet that local rows belong to. Rows from a
 * different scope are never shown or synchronised.
 */
export interface DataScope {
  readonly accountId: string;
  readonly spreadsheetId: string;
}

export const EXPENSE_CATEGORIES = [
  'Groceries',
  'Eating out',
  'Transport',
  'Bills',
  'Shopping',
  'Health',
  'Other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export function isExpenseCategory(value: unknown): value is ExpenseCategory {
  return typeof value === 'string' && (EXPENSE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Stored states of an unconfirmed submission:
 * - pending:   saved on the phone, not (or definitely not) written to Sheets
 * - sending:   an append request is in flight (persisted before the request)
 * - uncertain: the outcome of a sent request is unknown; must be reconciled
 *              by Expense ID before any further write
 * - blocked:   actionable failure; needs the user (reconnect, fix the sheet)
 *
 * "confirmed" is the terminal state: the row moves to confirmed_expenses and
 * the pending row is removed in the same local transaction.
 */
export const SUBMISSION_STATES = ['pending', 'sending', 'uncertain', 'blocked'] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];
export type SubmissionLifecycleState = SubmissionState | 'confirmed';

export function isSubmissionState(value: unknown): value is SubmissionState {
  return typeof value === 'string' && (SUBMISSION_STATES as readonly string[]).includes(value);
}

/**
 * Machine-readable reasons a submission is waiting. The UI maps each code to
 * an action ("Reconnect Google", "Restore the sheet"); no free text is stored,
 * so error columns can never hold personal data.
 */
export const SUBMISSION_ERROR_CODES = [
  'offline',
  'auth_required',
  'account_mismatch',
  'rate_limited',
  'server_error',
  'timeout',
  'sheet_missing',
  'sheet_trashed',
  'sheet_structure_changed',
  'invalid_request',
] as const;
export type SubmissionErrorCode = (typeof SUBMISSION_ERROR_CODES)[number];

export function isSubmissionErrorCode(value: unknown): value is SubmissionErrorCode {
  return typeof value === 'string' && (SUBMISSION_ERROR_CODES as readonly string[]).includes(value);
}

export function isValidDataScope(scope: DataScope): boolean {
  return scope.accountId.length > 0 && scope.spreadsheetId.length > 0;
}

export function isValidExpensePayload(payload: ExpensePayload): boolean {
  return (
    isLocalDate(payload.purchaseDate) &&
    Number.isSafeInteger(payload.amountMinor) &&
    payload.amountMinor > 0 &&
    payload.category.trim().length > 0
  );
}
