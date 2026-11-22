import { parseLocalDate } from '@/domain/dates';
import {
  isSubmissionErrorCode,
  isSubmissionState,
  isValidDataScope,
  isValidExpensePayload,
  type DataScope,
  type ExpensePayload,
  type SubmissionErrorCode,
  type SubmissionState,
} from '@/domain/expense';

import type { SqlDatabase } from './sql';

export interface SubmissionError {
  readonly code: SubmissionErrorCode;
  readonly httpStatus: number | null;
}

export interface PendingSubmission extends ExpensePayload, DataScope {
  /** Also the Expense ID written to the spreadsheet. */
  readonly submissionId: string;
  readonly state: SubmissionState;
  /** UTC ISO-8601 instant the user saved the expense. */
  readonly createdAt: string;
  readonly lastAttemptAt: string | null;
  readonly attemptCount: number;
  readonly lastError: SubmissionError | null;
}

export interface NewPendingSubmission extends ExpensePayload {
  readonly submissionId: string;
  readonly createdAt: string;
}

interface PendingSubmissionRow {
  submission_id: string;
  account_id: string;
  spreadsheet_id: string;
  purchase_date: string;
  description: string;
  amount_minor: number;
  category: string;
  state: string;
  created_at: string;
  last_attempt_at: string | null;
  attempt_count: number;
  last_error_code: string | null;
  last_error_http_status: number | null;
}

const COLUMNS = `submission_id, account_id, spreadsheet_id, purchase_date, description,
  amount_minor, category, state, created_at, last_attempt_at, attempt_count,
  last_error_code, last_error_http_status`;

// Composed once from constants; values are always bound with `?`.
const SELECT_BY_ID = `SELECT ${COLUMNS} FROM pending_submissions WHERE submission_id = ?`;
const SELECT_BY_SCOPE = `SELECT ${COLUMNS} FROM pending_submissions
  WHERE account_id = ? AND spreadsheet_id = ?
  ORDER BY created_at, submission_id`;

function toPendingSubmission(row: PendingSubmissionRow): PendingSubmission {
  const purchaseDate = parseLocalDate(row.purchase_date);
  if (purchaseDate === null || !isSubmissionState(row.state)) {
    throw new Error('Corrupt pending submission row');
  }
  return {
    submissionId: row.submission_id,
    accountId: row.account_id,
    spreadsheetId: row.spreadsheet_id,
    purchaseDate,
    description: row.description,
    amountMinor: row.amount_minor,
    category: row.category,
    state: row.state,
    createdAt: row.created_at,
    lastAttemptAt: row.last_attempt_at,
    attemptCount: row.attempt_count,
    lastError: isSubmissionErrorCode(row.last_error_code)
      ? { code: row.last_error_code, httpStatus: row.last_error_http_status }
      : null,
  };
}

/** Records a saved expense as a pending submission owned by `scope`. */
export async function insertPendingSubmission(
  db: SqlDatabase,
  scope: DataScope,
  submission: NewPendingSubmission,
): Promise<void> {
  if (!isValidDataScope(scope) || !isValidExpensePayload(submission)) {
    throw new Error('Invalid pending submission');
  }
  await db.run(
    `INSERT INTO pending_submissions
       (submission_id, account_id, spreadsheet_id, purchase_date, description,
        amount_minor, category, state, created_at, attempt_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0)`,
    [
      submission.submissionId,
      scope.accountId,
      scope.spreadsheetId,
      submission.purchaseDate,
      submission.description,
      submission.amountMinor,
      submission.category,
      submission.createdAt,
    ],
  );
}

export async function getPendingSubmission(
  db: SqlDatabase,
  submissionId: string,
): Promise<PendingSubmission | null> {
  const row = await db.getFirst<PendingSubmissionRow>(SELECT_BY_ID, [submissionId]);
  return row === null ? null : toPendingSubmission(row);
}

/** Pending submissions for one scope, oldest first (the send order). */
export async function listPendingSubmissions(
  db: SqlDatabase,
  scope: DataScope,
): Promise<PendingSubmission[]> {
  const rows = await db.getAll<PendingSubmissionRow>(SELECT_BY_SCOPE, [
    scope.accountId,
    scope.spreadsheetId,
  ]);
  return rows.map(toPendingSubmission);
}
