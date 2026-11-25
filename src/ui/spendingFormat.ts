import { addDays, localDateParts, type LocalDate, type Period } from '@/domain/dates';
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

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function weekdayOf(date: LocalDate): string {
  const { year, month, day } = localDateParts(date);
  // Calendar arithmetic only: the weekday of a calendar date is the same in every zone.
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? '';
}

/** "Today · Tue 24 Nov 2026", "Yesterday · Mon 23 Nov 2026" or "Fri 14 Nov 2026". */
export function purchaseDateLabel(date: LocalDate, today: LocalDate): string {
  const { year, month, day } = localDateParts(date);
  const text = `${weekdayOf(date).slice(0, 3)} ${day} ${MONTHS[month - 1]?.slice(0, 3)} ${year}`;
  if (date === today) return `Today · ${text}`;
  if (date === addDays(today, -1)) return `Yesterday · ${text}`;
  return text;
}

/** Spoken form, e.g. "today, Tuesday 24 November 2026". */
export function spokenPurchaseDate(date: LocalDate, today: LocalDate): string {
  const { year, month, day } = localDateParts(date);
  const text = `${weekdayOf(date)} ${day} ${MONTHS[month - 1]} ${year}`;
  if (date === today) return `today, ${text}`;
  if (date === addDays(today, -1)) return `yesterday, ${text}`;
  return text;
}

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

function tenthsText(tenths: number, trimZero: boolean): string {
  // 875 → "87.5"; 670 → "67.0" (or "67" when trimmed for speech).
  const whole = Math.floor(tenths / 10);
  const tenth = tenths % 10;
  return trimZero && tenth === 0 ? String(whole) : `${whole}.${tenth}`;
}

/** 36500 → "36,500". Integer counts only. */
export function groupThousands(count: number): string {
  return String(Math.trunc(count)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * A display percentage from tenths of a percent, always with one decimal so
 * a column lines up ("87.5%", "41.0%"). A positive amount whose share rounds
 * to 0 shows as "<0.1%" so it never reads as nothing.
 */
export function formatPercent(tenths: number, amountMinor: number): string {
  return tenths === 0 && amountMinor > 0 ? '<0.1%' : `${tenthsText(tenths, false)}%`;
}

/** Spoken form of a percentage, e.g. "87.5 percent" or "less than 0.1 percent". */
export function spokenPercent(tenths: number, amountMinor: number): string {
  return tenths === 0 && amountMinor > 0 ? 'less than 0.1 percent' : `${tenthsText(tenths, true)} percent`;
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
      return 'Couldn’t refresh: a year tab’s header row has changed. Check the spreadsheet.';
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
