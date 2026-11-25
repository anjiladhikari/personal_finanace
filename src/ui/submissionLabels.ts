import type { SubmissionErrorCode, SubmissionState } from '@/domain/expense';

/** User-facing status for an unconfirmed submission, including the action to take. */
export function submissionStatusLabel(state: SubmissionState, error: SubmissionErrorCode | null): string {
  switch (state) {
    case 'sending':
      return 'Sending to Google Sheets…';
    case 'uncertain':
      return error === 'auth_required'
        ? 'Not sure Google Sheets received it. Reconnect Google in Account so it can be checked.'
        : 'Not sure Google Sheets received it. Checking before trying again.';
    case 'blocked':
      switch (error) {
        case 'account_mismatch':
          return 'A different Google account is signed in. Check Account.';
        case 'sheet_missing':
          return 'The spreadsheet can’t be found. Check Account.';
        case 'sheet_trashed':
          return 'The spreadsheet is in the Google Drive trash. Check Account.';
        case 'sheet_structure_changed':
          return 'The header row of this year’s tab has changed. Fix it in Google Sheets, then retry.';
        case 'invalid_request':
          return 'Google Sheets rejected this row.';
        default:
          return 'Google access needs renewing. Reconnect in Account.';
      }
    case 'pending':
      switch (error) {
        case 'offline':
          return 'Waiting for an internet connection.';
        case 'rate_limited':
          return 'Google is busy. Will retry automatically.';
        case null:
          return 'Waiting to be sent.';
        default:
          return 'Couldn’t reach Google Sheets. Will retry automatically.';
      }
  }
}
