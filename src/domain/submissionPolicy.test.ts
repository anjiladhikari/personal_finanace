import {
  BACKOFF_DELAYS_MS,
  backoffDelayMs,
  nextAttemptAt,
  RECONCILE_SETTLE_MS,
  settledAt,
} from './submissionPolicy';

describe('backoff', () => {
  test('follows 10 s, 30 s, 2 min, 10 min, 30 min, then stays at 30 min, within ±20 %', () => {
    const expected = [10_000, 30_000, 120_000, 600_000, 1_800_000, 1_800_000, 1_800_000];
    expected.forEach((base, i) => {
      for (const id of ['a', 'b', 'some-uuid', 'another']) {
        const delay = backoffDelayMs(id, i + 1);
        expect(delay).toBeGreaterThanOrEqual(base * 0.8);
        expect(delay).toBeLessThanOrEqual(base * 1.2);
      }
    });
    expect(BACKOFF_DELAYS_MS).toHaveLength(5);
  });

  test('jitter is deterministic per submission and attempt', () => {
    expect(backoffDelayMs('x', 3)).toBe(backoffDelayMs('x', 3));
    const spread = new Set(['a', 'b', 'c', 'd', 'e'].map((id) => backoffDelayMs(id, 2)));
    expect(spread.size).toBeGreaterThan(1);
  });

  test('a never-attempted submission is due now', () => {
    expect(nextAttemptAt({ submissionId: 'x', attemptCount: 0, lastAttemptAt: null })).toBeNull();
    const last = '2026-11-22T00:00:00.000Z';
    expect(nextAttemptAt({ submissionId: 'x', attemptCount: 1, lastAttemptAt: last })).toBe(
      Date.parse(last) + backoffDelayMs('x', 1),
    );
  });
});

test('settle window runs from the start of the last attempt', () => {
  expect(settledAt('2026-11-22T00:00:00.000Z')).toBe(Date.parse('2026-11-22T00:00:00.000Z') + RECONCILE_SETTLE_MS);
  expect(settledAt(null)).toBe(0);
});
