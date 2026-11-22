import {
  addDays,
  daysInMonth,
  isDateInPeriod,
  isLeapYear,
  makeLocalDate,
  parseLocalDate,
  periodContaining,
  periodRange,
  shiftPeriod,
  todayLocalDate,
  validatePurchaseDate,
  type LocalDate,
  type Period,
} from './dates';

const d = (value: string): LocalDate => {
  const date = parseLocalDate(value);
  if (date === null) throw new Error(`bad fixture ${value}`);
  return date;
};

describe('test environment', () => {
  test('runs in a non-UTC zone so local/UTC mix-ups fail', () => {
    expect(process.env.TZ).toBe('Australia/Sydney');
    expect(new Date('2026-01-15T00:00:00Z').getTimezoneOffset()).toBe(-660); // AEDT
  });
});

describe('calendar validation', () => {
  test.each([
    '2026-11-22',
    '2024-02-29', // leap year
    '2000-02-29', // divisible by 400
    '1900-01-01',
    '2999-12-31',
    '2026-01-31',
    '2026-04-30',
  ])('accepts %s', (value) => {
    expect(parseLocalDate(value)).toBe(value);
  });

  test.each([
    '2023-02-29', // not a leap year
    '1900-02-29', // divisible by 100, not 400
    '2026-04-31',
    '2026-06-31',
    '2026-02-30',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '2026-01-32',
    '2026-1-05',
    '26-01-05',
    ' 2026-01-05',
    '2026-01-05 ',
    '2026-01-05T00:00',
    '2026/01/05',
    '20260105',
    '1899-12-31', // below supported range
    '3000-01-01', // above supported range
    '',
  ])('rejects %j', (value) => {
    expect(parseLocalDate(value)).toBeNull();
  });

  test('leap years and month lengths', () => {
    expect([1900, 2000, 2023, 2024, 2100].map(isLeapYear)).toEqual([false, true, false, true, false]);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2025, 2)).toBe(28);
    expect(daysInMonth(2026, 9)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  test('makeLocalDate rejects non-integers', () => {
    expect(makeLocalDate(2026, 1.5, 1)).toBeNull();
    expect(makeLocalDate(Number.NaN, 1, 1)).toBeNull();
  });
});

describe('todayLocalDate', () => {
  test('uses the local calendar, not the UTC date', () => {
    // 22 Nov 14:30 UTC is already 23 Nov 01:30 in Sydney (AEDT, UTC+11).
    expect(todayLocalDate(new Date('2026-11-22T14:30:00Z'))).toBe('2026-11-23');
    // 22 Nov 12:59 UTC is still 22 Nov 23:59 in Sydney.
    expect(todayLocalDate(new Date('2026-11-22T12:59:00Z'))).toBe('2026-11-22');
  });

  test('new year boundary in local time', () => {
    expect(todayLocalDate(new Date('2026-12-31T13:00:00Z'))).toBe('2027-01-01');
  });
});

describe('addDays', () => {
  test.each<[string, number, string]>([
    ['2024-02-28', 1, '2024-02-29'],
    ['2024-02-29', 1, '2024-03-01'],
    ['2025-02-28', 1, '2025-03-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2027-01-01', -1, '2026-12-31'],
    ['2026-03-01', -1, '2026-02-28'],
    // Sydney DST ends 2026-04-05 and starts 2026-10-04; days must not skip or repeat.
    ['2026-04-04', 1, '2026-04-05'],
    ['2026-04-05', 1, '2026-04-06'],
    ['2026-10-03', 1, '2026-10-04'],
    ['2026-10-04', 1, '2026-10-05'],
    ['2026-01-01', 365, '2027-01-01'],
    ['2024-01-01', 366, '2025-01-01'],
  ])('%s %+i → %s', (start, days, expected) => {
    expect(addDays(d(start), days)).toBe(expected);
  });

  test('every day of a leap year is visited once', () => {
    let date = d('2024-01-01');
    const seen = new Set<string>();
    while (date < '2025-01-01') {
      seen.add(date);
      date = addDays(date, 1);
    }
    expect(seen.size).toBe(366);
  });

  test('rejects results outside the supported range', () => {
    expect(() => addDays(d('2999-12-31'), 1)).toThrow(RangeError);
    expect(() => addDays(d('1900-01-01'), -1)).toThrow(RangeError);
  });
});

describe('validatePurchaseDate', () => {
  const today = d('2026-11-22');

  test('accepts today, backdated dates and the earliest date', () => {
    expect(validatePurchaseDate('2026-11-22', today)).toEqual({ ok: true, date: '2026-11-22' });
    expect(validatePurchaseDate('2021-03-15', today)).toEqual({ ok: true, date: '2021-03-15' });
    expect(validatePurchaseDate('2000-01-01', today)).toEqual({ ok: true, date: '2000-01-01' });
  });

  test.each([
    ['2026-11-23', 'in_future'],
    ['2027-01-01', 'in_future'],
    ['1999-12-31', 'before_earliest'],
    ['2026-02-30', 'invalid_date'],
    ['22/11/2026', 'invalid_date'],
  ])('%s → %s', (value, error) => {
    expect(validatePurchaseDate(value, today)).toEqual({ ok: false, error });
  });
});

describe('period boundaries', () => {
  test.each<[Period, string, string]>([
    [{ kind: 'day', date: d('2026-11-22') }, '2026-11-22', '2026-11-23'],
    [{ kind: 'day', date: d('2026-12-31') }, '2026-12-31', '2027-01-01'],
    [{ kind: 'day', date: d('2024-02-29') }, '2024-02-29', '2024-03-01'],
    [{ kind: 'day', date: d('2026-10-04') }, '2026-10-04', '2026-10-05'], // DST start day
    [{ kind: 'month', year: 2026, month: 11 }, '2026-11-01', '2026-12-01'],
    [{ kind: 'month', year: 2026, month: 12 }, '2026-12-01', '2027-01-01'],
    [{ kind: 'month', year: 2024, month: 2 }, '2024-02-01', '2024-03-01'],
    [{ kind: 'month', year: 2025, month: 2 }, '2025-02-01', '2025-03-01'],
    [{ kind: 'year', year: 2026 }, '2026-01-01', '2027-01-01'],
    [{ kind: 'year', year: 2999 }, '2999-01-01', '3000-01-01'],
  ])('%o → [%s, %s)', (period, start, endExclusive) => {
    expect(periodRange(period)).toEqual({ start, endExclusive });
  });

  test('all time has no bounds', () => {
    expect(periodRange({ kind: 'all' })).toBeNull();
  });

  test('membership is half-open: start included, end excluded', () => {
    const november: Period = { kind: 'month', year: 2026, month: 11 };
    expect(isDateInPeriod(d('2026-10-31'), november)).toBe(false);
    expect(isDateInPeriod(d('2026-11-01'), november)).toBe(true);
    expect(isDateInPeriod(d('2026-11-30'), november)).toBe(true);
    expect(isDateInPeriod(d('2026-12-01'), november)).toBe(false);
    expect(isDateInPeriod(d('1950-06-01'), { kind: 'all' })).toBe(true);
  });

  test('rejects malformed periods', () => {
    expect(() => periodRange({ kind: 'month', year: 2026, month: 13 })).toThrow(RangeError);
    expect(() => periodRange({ kind: 'year', year: 1800 })).toThrow(RangeError);
  });
});

describe('periodContaining and shiftPeriod', () => {
  const date = d('2026-01-15');

  test('builds each period kind around a date', () => {
    expect(periodContaining('day', date)).toEqual({ kind: 'day', date: '2026-01-15' });
    expect(periodContaining('month', date)).toEqual({ kind: 'month', year: 2026, month: 1 });
    expect(periodContaining('year', date)).toEqual({ kind: 'year', year: 2026 });
    expect(periodContaining('all', date)).toEqual({ kind: 'all' });
  });

  test.each<[Period, number, Period]>([
    [{ kind: 'month', year: 2026, month: 1 }, -1, { kind: 'month', year: 2025, month: 12 }],
    [{ kind: 'month', year: 2026, month: 12 }, 1, { kind: 'month', year: 2027, month: 1 }],
    [{ kind: 'month', year: 2026, month: 3 }, -14, { kind: 'month', year: 2025, month: 1 }],
    [{ kind: 'month', year: 2026, month: 11 }, 25, { kind: 'month', year: 2028, month: 12 }],
    [{ kind: 'year', year: 2026 }, -1, { kind: 'year', year: 2025 }],
    [{ kind: 'day', date: d('2026-03-01') }, -1, { kind: 'day', date: d('2026-02-28') }],
    [{ kind: 'all' }, 5, { kind: 'all' }],
  ])('%o shifted %+i → %o', (period, steps, expected) => {
    expect(shiftPeriod(period, steps)).toEqual(expected);
  });

  test('rejects shifts outside the supported range', () => {
    expect(() => shiftPeriod({ kind: 'year', year: 2999 }, 1)).toThrow(RangeError);
    expect(() => shiftPeriod({ kind: 'month', year: 1900, month: 1 }, -1)).toThrow(RangeError);
  });
});
