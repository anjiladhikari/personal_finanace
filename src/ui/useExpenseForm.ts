import { useCallback, useEffect, useRef, useState } from 'react';

import { onSubmissionsChanged } from '@/db/changes';
import { todayLocalDate } from '@/domain/dates';
import type { SubmissionErrorCode, SubmissionState } from '@/domain/expense';
import { emptyDraft, validateExpenseDraft, type ExpenseDraft, type ExpenseDraftErrors } from '@/domain/expenseDraft';
import { useSubmissionEngine } from '@/sync/SubmissionEngineContext';
import type { SaveOutcome } from '@/sync/submissions';

export type FormStatus =
  | { readonly kind: 'editing' }
  | { readonly kind: 'saving' }
  /** Saved on the phone but not confirmed in Sheets; the draft is kept and locked to this submission. */
  | {
      readonly kind: 'unresolved';
      readonly submissionId: string;
      readonly state: SubmissionState;
      readonly error: SubmissionErrorCode | null;
    };

export type FormNotice = 'saved' | 'saved_sheet_only' | 'storage_failed' | 'not_set_up' | null;

/**
 * Form state for one expense. Saving is guarded against double taps; the
 * form resets only once Google has confirmed the row. Until then the draft
 * stays on screen, and pressing Save again retries the same submission
 * (same Expense ID) instead of creating a second one.
 */
export function useExpenseForm(minorUnits: number) {
  const engine = useSubmissionEngine();
  const [draft, setDraft] = useState<ExpenseDraft>(() => emptyDraft(todayLocalDate()));
  const [showErrors, setShowErrors] = useState(false);
  const [status, setStatus] = useState<FormStatus>({ kind: 'editing' });
  const [notice, setNotice] = useState<FormNotice>(null);
  const busy = useRef(false);

  const validation = validateExpenseDraft(draft, { minorUnits, today: todayLocalDate() });
  const errors: ExpenseDraftErrors = showErrors && !validation.ok ? validation.errors : {};
  const locked = status.kind !== 'editing';

  const reset = useCallback((next: FormNotice) => {
    setDraft(emptyDraft(todayLocalDate()));
    setShowErrors(false);
    setStatus({ kind: 'editing' });
    setNotice(next);
  }, []);

  const apply = useCallback(
    (outcome: SaveOutcome | null) => {
      if (outcome === null) return;
      switch (outcome.kind) {
        case 'confirmed':
          reset('saved');
          break;
        case 'confirmed_remote_only':
          reset('saved_sheet_only');
          break;
        case 'unresolved':
          setStatus({ kind: 'unresolved', submissionId: outcome.submissionId, state: outcome.state, error: outcome.error });
          break;
        case 'not_saved':
          setStatus({ kind: 'editing' });
          setNotice(outcome.reason);
          break;
      }
    },
    [reset],
  );

  // A background retry may confirm the submission this form is holding.
  const unresolvedId = status.kind === 'unresolved' ? status.submissionId : null;
  useEffect(() => {
    if (unresolvedId === null) return undefined;
    return onSubmissionsChanged(() => {
      if (busy.current) return;
      void engine.outcomeOf(unresolvedId).then((outcome) => {
        if (busy.current) return;
        if (outcome.kind === 'unresolved') {
          setStatus((current) =>
            current.kind === 'unresolved' && current.submissionId === outcome.submissionId
              ? { kind: 'unresolved', submissionId: outcome.submissionId, state: outcome.state, error: outcome.error }
              : current,
          );
        } else {
          apply(outcome);
        }
      });
    });
  }, [engine, unresolvedId, apply]);

  const save = useCallback(async () => {
    if (busy.current) return; // double tap
    if (status.kind === 'unresolved') {
      busy.current = true;
      const held = status.submissionId;
      setStatus({ kind: 'saving' });
      try {
        apply(await engine.retry(held));
      } finally {
        busy.current = false;
      }
      return;
    }
    if (!validation.ok) {
      setShowErrors(true);
      return;
    }
    busy.current = true;
    setNotice(null);
    setStatus({ kind: 'saving' });
    try {
      apply(await engine.submit(validation.payload));
    } catch {
      setStatus({ kind: 'editing' });
      setNotice('storage_failed');
    } finally {
      busy.current = false;
    }
  }, [engine, status, validation, apply]);

  const update = useCallback(
    (patch: Partial<ExpenseDraft>) => {
      if (locked) return;
      setNotice(null);
      setDraft((current) => ({ ...current, ...patch }));
    },
    [locked],
  );

  /** Leave the unresolved submission to the retry queue and start a new expense. */
  const startNew = useCallback(() => {
    if (busy.current) return;
    reset(null);
  }, [reset]);

  return { draft, errors, status, notice, locked, update, save, startNew };
}
