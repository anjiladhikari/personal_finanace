/**
 * Money is always held as an integer count of the currency's minor units
 * (for AUD, cents). Decimal text is converted with string arithmetic only;
 * floating-point multiplication is never used to derive minor units.
 */

export interface CurrencyConfig {
  /** ISO 4217 code, e.g. "AUD". */
  readonly code: string;
  /** Digits after the decimal point, e.g. 2 for AUD, 0 for JPY. */
  readonly minorUnits: number;
}

/** Provisional V1 currency. Stored in app_settings; change there, not here. */
export const DEFAULT_CURRENCY: CurrencyConfig = { code: 'AUD', minorUnits: 2 };

/** Provisional upper bound for a single expense, in major units (999,999.99 AUD). */
export const MAX_EXPENSE_MAJOR_UNITS = 999_999;

export const MAX_SUPPORTED_MINOR_UNITS = 4;

export type AmountParseError =
  | 'empty'
  | 'invalid_format'
  | 'too_many_decimals'
  | 'not_positive'
  | 'too_large';

export type AmountParseResult =
  | { readonly ok: true; readonly amountMinor: number }
  | { readonly ok: false; readonly error: AmountParseError };

// ASCII digits only (no `u` flag, so \d is [0-9]).
const PLAIN_AMOUNT = /^(\d+)(?:\.(\d*))?$/;
const GROUPED_AMOUNT = /^(\d{1,3}(?:,\d{3})+)(?:\.(\d*))?$/;
const FRACTION_ONLY = /^\.(\d+)$/;

// Above 15 digits, Number() can no longer represent every integer exactly.
const MAX_SAFE_DIGITS = 15;

export function isValidCurrencyConfig(config: CurrencyConfig): boolean {
  return (
    /^[A-Z]{3}$/.test(config.code) &&
    Number.isInteger(config.minorUnits) &&
    config.minorUnits >= 0 &&
    config.minorUnits <= MAX_SUPPORTED_MINOR_UNITS
  );
}

function assertMinorUnits(minorUnits: number): void {
  if (
    !Number.isInteger(minorUnits) ||
    minorUnits < 0 ||
    minorUnits > MAX_SUPPORTED_MINOR_UNITS
  ) {
    throw new RangeError('Unsupported minor-unit precision');
  }
}

/** Largest amount a single expense may have, in minor units. */
export function maxExpenseAmountMinor(minorUnits: number): number {
  assertMinorUnits(minorUnits);
  return (MAX_EXPENSE_MAJOR_UNITS + 1) * 10 ** minorUnits - 1;
}

/**
 * Parses user-entered decimal text such as "12", "12.5", ".5" or "1,234.56"
 * into positive integer minor units. Signs, exponents, comma decimals and
 * non-ASCII digits are rejected.
 */
export function parseAmount(input: string, minorUnits: number): AmountParseResult {
  assertMinorUnits(minorUnits);
  const text = input.trim();
  if (text === '') return { ok: false, error: 'empty' };
  if (text.startsWith('-')) return { ok: false, error: 'not_positive' };

  let integerDigits: string;
  let fractionDigits: string;
  const plain = PLAIN_AMOUNT.exec(text) ?? GROUPED_AMOUNT.exec(text);
  if (plain) {
    integerDigits = (plain[1] ?? '').replaceAll(',', '');
    fractionDigits = plain[2] ?? '';
  } else {
    const fractionOnly = FRACTION_ONLY.exec(text);
    if (!fractionOnly) return { ok: false, error: 'invalid_format' };
    integerDigits = '0';
    fractionDigits = fractionOnly[1] ?? '';
  }

  if (fractionDigits.length > minorUnits) return { ok: false, error: 'too_many_decimals' };

  const digits = (integerDigits + fractionDigits.padEnd(minorUnits, '0')).replace(/^0+/, '');
  if (digits === '') return { ok: false, error: 'not_positive' };
  if (digits.length > MAX_SAFE_DIGITS) return { ok: false, error: 'too_large' };

  const amountMinor = Number(digits);
  if (amountMinor > maxExpenseAmountMinor(minorUnits)) return { ok: false, error: 'too_large' };
  return { ok: true, amountMinor };
}

export interface FormatOptions {
  /** Insert thousands separators. Defaults to true. */
  readonly grouping?: boolean;
}

/** Formats minor units as a decimal string, e.g. 123456 → "1,234.56". */
export function formatMinorUnits(
  amountMinor: number,
  minorUnits: number,
  options: FormatOptions = {},
): string {
  assertMinorUnits(minorUnits);
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError('Amount must be a safe integer of minor units');
  }
  const sign = amountMinor < 0 ? '-' : '';
  const digits = String(Math.abs(amountMinor)).padStart(minorUnits + 1, '0');
  const splitAt = digits.length - minorUnits;
  let integerPart = digits.slice(0, splitAt);
  const fractionPart = digits.slice(splitAt);
  if (options.grouping ?? true) {
    integerPart = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  return minorUnits > 0 ? `${sign}${integerPart}.${fractionPart}` : `${sign}${integerPart}`;
}

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  AUD: '$',
  NZD: '$',
  USD: '$',
  CAD: '$',
  EUR: '€',
  GBP: '£',
};

/** Formats minor units for display, e.g. 123456 AUD → "$1,234.56". */
export function formatMoney(amountMinor: number, currency: CurrencyConfig): string {
  const amount = formatMinorUnits(Math.abs(amountMinor), currency.minorUnits);
  const sign = amountMinor < 0 ? '-' : '';
  const symbol = CURRENCY_SYMBOLS[currency.code];
  return symbol === undefined ? `${sign}${currency.code} ${amount}` : `${sign}${symbol}${amount}`;
}
