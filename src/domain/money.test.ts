import {
  formatMinorUnits,
  formatMoney,
  isValidCurrencyConfig,
  maxExpenseAmountMinor,
  parseAmount,
  type AmountParseError,
} from './money';

describe('parseAmount (2 minor units)', () => {
  test.each<[string, number]>([
    ['12', 1200],
    ['12.3', 1230],
    ['12.34', 1234],
    ['12.', 1200],
    ['0.01', 1],
    ['.5', 50],
    ['0.10', 10],
    ['007.50', 750],
    ['  7.5  ', 750],
    ['1,234.56', 123456],
    ['999,999.99', 99_999_999],
    ['999999.99', 99_999_999],
    // Float maths gets these wrong: 1.1 * 100 = 110.00000000000001, 0.29 * 100 = 28.999999999999996
    ['1.10', 110],
    ['0.29', 29],
    ['4.35', 435],
  ])('"%s" → %i', (input, expected) => {
    expect(parseAmount(input, 2)).toEqual({ ok: true, amountMinor: expected });
  });

  test('the maximum is 999,999.99', () => {
    expect(maxExpenseAmountMinor(2)).toBe(99_999_999);
    expect(maxExpenseAmountMinor(0)).toBe(999_999);
  });

  test.each<[string, AmountParseError]>([
    ['', 'empty'],
    ['   ', 'empty'],
    ['0', 'not_positive'],
    ['0.00', 'not_positive'],
    ['.0', 'not_positive'],
    ['-5', 'not_positive'],
    ['-0.01', 'not_positive'],
    ['12.345', 'too_many_decimals'],
    ['0.001', 'too_many_decimals'],
    ['1000000', 'too_large'],
    ['999999.991', 'too_many_decimals'],
    ['1,000,000.00', 'too_large'],
    ['123456789012345678', 'too_large'],
    ['abc', 'invalid_format'],
    ['.', 'invalid_format'],
    ['12.5.1', 'invalid_format'],
    ['12,50', 'invalid_format'],
    ['1,23', 'invalid_format'],
    ['1,2345', 'invalid_format'],
    [',123', 'invalid_format'],
    ['+5', 'invalid_format'],
    ['1e3', 'invalid_format'],
    ['Infinity', 'invalid_format'],
    ['NaN', 'invalid_format'],
    ['$12', 'invalid_format'],
    ['12 34', 'invalid_format'],
    ['١٢', 'invalid_format'], // Arabic-Indic digits
    ['１２', 'invalid_format'], // full-width digits
    ['0x10', 'invalid_format'],
  ])('"%s" → %s', (input, error) => {
    expect(parseAmount(input, 2)).toEqual({ ok: false, error });
  });
});

describe('parseAmount with other precisions', () => {
  test('0 minor units (e.g. JPY)', () => {
    expect(parseAmount('1500', 0)).toEqual({ ok: true, amountMinor: 1500 });
    expect(parseAmount('1500.', 0)).toEqual({ ok: true, amountMinor: 1500 });
    expect(parseAmount('15.5', 0)).toEqual({ ok: false, error: 'too_many_decimals' });
  });

  test('3 minor units (e.g. KWD)', () => {
    expect(parseAmount('1.234', 3)).toEqual({ ok: true, amountMinor: 1234 });
    expect(parseAmount('1.2', 3)).toEqual({ ok: true, amountMinor: 1200 });
    expect(parseAmount('1.2345', 3)).toEqual({ ok: false, error: 'too_many_decimals' });
  });

  test('rejects unsupported precision', () => {
    expect(() => parseAmount('1', -1)).toThrow(RangeError);
    expect(() => parseAmount('1', 5)).toThrow(RangeError);
    expect(() => parseAmount('1', 1.5)).toThrow(RangeError);
  });
});

describe('formatMinorUnits', () => {
  test.each<[number, number, string]>([
    [0, 2, '0.00'],
    [1, 2, '0.01'],
    [5, 2, '0.05'],
    [99, 2, '0.99'],
    [100, 2, '1.00'],
    [123456, 2, '1,234.56'],
    [99_999_999, 2, '999,999.99'],
    [-150, 2, '-1.50'],
    [1500, 0, '1,500'],
    [1234, 3, '1.234'],
    [123_456_789_012, 2, '1,234,567,890.12'],
  ])('%i with %i decimals → %s', (amount, minorUnits, expected) => {
    expect(formatMinorUnits(amount, minorUnits)).toBe(expected);
  });

  test('can omit grouping', () => {
    expect(formatMinorUnits(123456, 2, { grouping: false })).toBe('1234.56');
  });

  test('rejects non-integer or unsafe amounts', () => {
    expect(() => formatMinorUnits(1.5, 2)).toThrow(RangeError);
    expect(() => formatMinorUnits(Number.MAX_SAFE_INTEGER + 1, 2)).toThrow(RangeError);
    expect(() => formatMinorUnits(Number.NaN, 2)).toThrow(RangeError);
  });

  test('parse(format(x)) round-trips for every cent up to $20 and sampled larger values', () => {
    const samples = [
      ...Array.from({ length: 2001 }, (_, i) => i + 1),
      12_345,
      1_000_000,
      55_555_555,
      99_999_999,
    ];
    for (const amount of samples) {
      expect(parseAmount(formatMinorUnits(amount, 2), 2)).toEqual({ ok: true, amountMinor: amount });
    }
  });
});

describe('formatMoney', () => {
  test('uses the currency symbol when known', () => {
    expect(formatMoney(123456, { code: 'AUD', minorUnits: 2 })).toBe('$1,234.56');
    expect(formatMoney(-500, { code: 'AUD', minorUnits: 2 })).toBe('-$5.00');
  });

  test('falls back to the ISO code', () => {
    expect(formatMoney(1500, { code: 'JPY', minorUnits: 0 })).toBe('JPY 1,500');
  });
});

describe('isValidCurrencyConfig', () => {
  test.each([
    [{ code: 'AUD', minorUnits: 2 }, true],
    [{ code: 'JPY', minorUnits: 0 }, true],
    [{ code: 'aud', minorUnits: 2 }, false],
    [{ code: 'AUDD', minorUnits: 2 }, false],
    [{ code: 'AUD', minorUnits: 5 }, false],
    [{ code: 'AUD', minorUnits: 2.5 }, false],
  ])('%o → %s', (config, expected) => {
    expect(isValidCurrencyConfig(config)).toBe(expected);
  });
});
