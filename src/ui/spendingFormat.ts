import { localDateParts, type Period } from '@/domain/dates';
import type { LedgerIssueKind } from '@/domain/ledger';
import type { RefreshFailureCode } from '@/sync/refresh';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function periodLabel(period: Period): string {
  switch (period.kind) {
    case 'day': {
      const { year, month, day } = localDateParts(period.date);
      return `${day} ${MONTHS[month - 1]?.slice(0, 3)} ${year}`;
    }
    case 'month':
      return `${MONTHS[period.month - 1]} ${period.year}`;
    case 'year':
      return String(period.year);
    case 'all':
      return 'All time';
  }
}

function tenthsText(tenths: number): string {
  // 875 → "87.5", 670 → "67", 1000 → "100": one decimal, without a trailing ".0".
  const whole = Math.floor(tenths / 10);
  const tenth = tenths % 10;
  return tenth === 0 ? String(whole) : `${whole}.${tenth}`;
}

/**
 * A display percentage from tenths of a percent, e.g. "87.5%". A positive
 * amount whose share rounds to 0 shows as "<0.1%" so it never reads as nothing.
 */
export function formatPercent(tenths: number, amountMinor: number): string {
  return tenths === 0 && amountMinor > 0 ? '<0.1%' : `${tenthsText(tenths)}%`;
}

/** Spoken form of a percentage, e.g. "87.5 percent" or "less than 0.1 percent". */
export function spokenPercent(tenths: number, amountMinor: number): string {
  return tenths === 0 && amountMinor > 0 ? 'less than 0.1 percent' : `${tenthsText(tenths)} percent`;
}

/** Local date and time of an ISO instant, e.g. "22 Nov 2026, 14:05". */
export function formatSyncTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${date.getDate()} ${MONTHS[date.getMonth()]?.slice(0, 3)} ${date.getFullYear()}, ${hh}:${mm}`;
}

export function refreshFailureMessage(code: RefreshFailureCode): string {
  switch (code) {
    case 'offline':
    case 'timeout':
      return 'Couldn’t refresh: no connection to Google. Showing saved results.';
    case 'auth_required':
      return 'Couldn’t refresh: Google access needs renewing. Reconnect in Account.';
    case 'account_mismatch':
      return 'Couldn’t refresh: a different Google account is signed in. Check Account.';
    case 'sheet_missing':
      return 'Couldn’t refresh: the spreadsheet can’t be found. Check Account.';
    case 'sheet_trashed':
      return 'Couldn’t refresh: the spreadsheet is in the Google Drive trash. Check Account.';
    case 'sheet_structure_changed':
      return 'Couldn’t refresh: the Expenses header row has changed. Check Account.';
    case 'changed_during_refresh':
      return 'Couldn’t refresh: the sheet kept changing while it was being read. Try again.';
    default:
      return 'Couldn’t refresh: Google Sheets didn’t respond. Try again.';
  }
}

export function sheetIssueMessage(kind: LedgerIssueKind): string {
  switch (kind) {
    case 'missing_id':
      return 'the Expense ID is missing';
    case 'invalid_date':
      return 'the date isn’t a valid YYYY-MM-DD date';
    case 'invalid_amount':
      return 'the amount isn’t a valid positive amount';
    case 'missing_category':
      return 'the category is empty';
    case 'conflicting_duplicate':
      return 'another row has the same Expense ID with different values';
    case 'duplicate_resolved':
      return 'exact duplicate of an earlier row (counted once)';
  }
}
