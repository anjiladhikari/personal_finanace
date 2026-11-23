/**
 * Retry and reconciliation policy (Prompt 1 design; values are provisional).
 *
 * - Each append request times out after ATTEMPT_TIMEOUT_MS.
 * - Retryable failures back off 10 s, 30 s, 2 min, 10 min, 30 min, then every
 *   30 min, with ±20 % jitter. There is no attempt limit; after
 *   ATTEMPT_WARNING_THRESHOLD failures the UI says so.
 * - App foreground, regained connectivity and "Retry now" reset the backoff.
 * - An uncertain submission is reconciled by Expense ID before any new write.
 *   An absent ID is not proof the earlier request failed: a re-send is only
 *   allowed once RECONCILE_SETTLE_MS have passed since that request started
 *   and a read after that point still does not find the ID.
 */

export const ATTEMPT_TIMEOUT_MS = 20_000;
export const BACKOFF_DELAYS_MS = [10_000, 30_000, 120_000, 600_000, 1_800_000] as const;
export const BACKOFF_JITTER = 0.2;
export const RECONCILE_SETTLE_MS = 120_000;
export const ATTEMPT_WARNING_THRESHOLD = 5;

/** Deterministic jitter in [-1, 1] so a restart computes the same schedule. */
function jitterUnit(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 0xffffffff) * 2 - 1;
}

/** Delay before the next attempt, given how many attempts have been made (>= 1). */
export function backoffDelayMs(submissionId: string, attemptCount: number): number {
  const index = Math.min(Math.max(attemptCount, 1), BACKOFF_DELAYS_MS.length) - 1;
  const base = BACKOFF_DELAYS_MS[index] ?? BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1] ?? 0;
  return Math.round(base * (1 + BACKOFF_JITTER * jitterUnit(`${submissionId}:${attemptCount}`)));
}

/** When a pending submission may next be sent; null means now. */
export function nextAttemptAt(
  submission: { readonly submissionId: string; readonly attemptCount: number; readonly lastAttemptAt: string | null },
): number | null {
  if (submission.attemptCount === 0 || submission.lastAttemptAt === null) return null;
  return Date.parse(submission.lastAttemptAt) + backoffDelayMs(submission.submissionId, submission.attemptCount);
}

/** Earliest time an uncertain submission may be considered unwritten. */
export function settledAt(lastAttemptAt: string | null): number {
  return lastAttemptAt === null ? 0 : Date.parse(lastAttemptAt) + RECONCILE_SETTLE_MS;
}
