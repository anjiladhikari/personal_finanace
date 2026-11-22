/**
 * Purchase dates are calendar dates ("YYYY-MM-DD") in the user's local
 * calendar. They are never derived from, or converted through, UTC instants.
 * Day arithmetic uses Date.UTC purely as a proleptic-Gregorian calculator,
 * where no daylight-saving transitions exist.
 */

declare const localDateBrand: unique symbol;

/** A validated calendar date in "YYYY-MM-DD" form. */
export type LocalDate = string & { readonly [localDateBrand]: true };

/**
 * Four-digit years keep string comparison equal to date order, which SQLite
 * range queries rely on.
 */
export const MIN_SUPPORTED_YEAR = 1900;
export const MAX_SUPPORTED_YEAR = 2999;

/** Provisional earliest accepted purchase date for backdated entries. */
export const EARLIEST_PURCHASE_DATE = '2000-01-01' as LocalDate;

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export interface DateParts {
  readonly year: number;
  readonly month: number; // 1–12
  readonly day: number; // 1–31
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function formatParts(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** Builds a LocalDate from parts, or returns null if the date does not exist. */
export function makeLocalDate(year: number, month: number, day: number): LocalDate | null {
  if (![year, month, day].every(Number.isInteger)) return null;
  if (year < MIN_SUPPORTED_YEAR || year > MAX_SUPPORTED_YEAR) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return formatParts(year, month, day) as LocalDate;
}

/** Parses exact "YYYY-MM-DD" text. No trimming, times or other formats. */
export function parseLocalDate(value: string): LocalDate | null {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) return null;
  return makeLocalDate(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function isLocalDate(value: unknown): value is LocalDate {
  return typeof value === 'string' && parseLocalDate(value) !== null;
}

export function localDateParts(date: LocalDate): DateParts {
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
}

/** Today's date in the device's local calendar (not the UTC date). */
export function todayLocalDate(now: Date = new Date()): LocalDate {
  const date = makeLocalDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
  if (date === null) throw new RangeError('Device date is outside the supported range');
  return date;
}

function fromUtcCalculator(ms: number): LocalDate {
  const d = new Date(ms);
  const date = makeLocalDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  if (date === null) throw new RangeError('Date is outside the supported range');
  return date;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isInteger(days)) throw new RangeError('days must be an integer');
  const { year, month, day } = localDateParts(date);
  return fromUtcCalculator(Date.UTC(year, month - 1, day) + days * MS_PER_DAY);
}

export function compareLocalDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type PurchaseDateError = 'invalid_date' | 'in_future' | 'before_earliest';

export type PurchaseDateResult =
  | { readonly ok: true; readonly date: LocalDate }
  | { readonly ok: false; readonly error: PurchaseDateError };

/** Valid purchase dates run from EARLIEST_PURCHASE_DATE to today inclusive. */
export function validatePurchaseDate(value: string, today: LocalDate): PurchaseDateResult {
  const date = parseLocalDate(value);
  if (date === null) return { ok: false, error: 'invalid_date' };
  if (date > today) return { ok: false, error: 'in_future' };
  if (date < EARLIEST_PURCHASE_DATE) return { ok: false, error: 'before_earliest' };
  return { ok: true, date };
}

// ---------------------------------------------------------------------------
// Reporting periods

export type PeriodKind = 'day' | 'month' | 'year' | 'all';

export type Period =
  | { readonly kind: 'day'; readonly date: LocalDate }
  | { readonly kind: 'month'; readonly year: number; readonly month: number }
  | { readonly kind: 'year'; readonly year: number }
  | { readonly kind: 'all' };

/**
 * Half-open range: start <= purchase_date < endExclusive. endExclusive is a
 * boundary, so for 31 Dec 2999 it can name a date just past the supported range.
 */
export interface DateRange {
  readonly start: LocalDate;
  readonly endExclusive: LocalDate;
}

function assertSupportedYear(year: number): void {
  if (!Number.isInteger(year) || year < MIN_SUPPORTED_YEAR || year > MAX_SUPPORTED_YEAR) {
    throw new RangeError('Year is outside the supported range');
  }
}

function assertMonth(month: number): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError('Month must be 1–12');
  }
}

export function periodContaining(kind: PeriodKind, date: LocalDate): Period {
  const { year, month } = localDateParts(date);
  switch (kind) {
    case 'day':
      return { kind, date };
    case 'month':
      return { kind, year, month };
    case 'year':
      return { kind, year };
    case 'all':
      return { kind };
  }
}

/** The date range for a period, or null for all time (no date filter). */
export function periodRange(period: Period): DateRange | null {
  switch (period.kind) {
    case 'day': {
      const { year, month, day } = localDateParts(period.date);
      const next = new Date(Date.UTC(year, month - 1, day) + MS_PER_DAY);
      return {
        start: period.date,
        endExclusive: formatParts(
          next.getUTCFullYear(),
          next.getUTCMonth() + 1,
          next.getUTCDate(),
        ) as LocalDate,
      };
    }
    case 'month': {
      assertSupportedYear(period.year);
      assertMonth(period.month);
      const nextYear = period.month === 12 ? period.year + 1 : period.year;
      const nextMonth = period.month === 12 ? 1 : period.month + 1;
      return {
        start: formatParts(period.year, period.month, 1) as LocalDate,
        endExclusive: formatParts(nextYear, nextMonth, 1) as LocalDate,
      };
    }
    case 'year':
      assertSupportedYear(period.year);
      return {
        start: formatParts(period.year, 1, 1) as LocalDate,
        endExclusive: formatParts(period.year + 1, 1, 1) as LocalDate,
      };
    case 'all':
      return null;
  }
}

/** Moves a period by whole steps (days, months or years). "all" is unchanged. */
export function shiftPeriod(period: Period, steps: number): Period {
  if (!Number.isInteger(steps)) throw new RangeError('steps must be an integer');
  switch (period.kind) {
    case 'day':
      return { kind: 'day', date: addDays(period.date, steps) };
    case 'month': {
      assertMonth(period.month);
      const index = period.year * 12 + (period.month - 1) + steps;
      const year = Math.floor(index / 12);
      assertSupportedYear(year);
      return { kind: 'month', year, month: (index % 12) + 1 };
    }
    case 'year': {
      const year = period.year + steps;
      assertSupportedYear(year);
      return { kind: 'year', year };
    }
    case 'all':
      return period;
  }
}

export function isDateInPeriod(date: LocalDate, period: Period): boolean {
  const range = periodRange(period);
  return range === null || (date >= range.start && date < range.endExclusive);
}
