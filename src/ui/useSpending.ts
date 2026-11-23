import { useEffect, useState, useSyncExternalStore } from 'react';

import { onSubmissionsChanged } from '@/db/changes';
import { useDatabase } from '@/db/DatabaseContext';
import { listSheetIssues, type StoredSheetIssue } from '@/db/ledgerCache';
import { analyzeSpending, type SpendingAnalysis } from '@/db/spendingAnalysis';
import type { Period } from '@/domain/dates';
import type { DataScope } from '@/domain/expense';
import type { SubmissionEngine, SyncStatus } from '@/sync/submissions';

export type AnalysisState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly analysis: SpendingAnalysis; readonly issues: readonly StoredSheetIssue[] }
  | { readonly status: 'error' };

/**
 * Spending for a period from the local cache only. Re-reads when the period
 * changes or local data changes (save confirmed, refresh committed).
 */
export function useSpendingAnalysis(scope: DataScope, period: Period): AnalysisState {
  const db = useDatabase();
  const [state, setState] = useState<AnalysisState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    const load = () => {
      Promise.all([analyzeSpending(db, scope, period), listSheetIssues(db, scope)]).then(
        ([analysis, issues]) => active && setState({ status: 'ready', analysis, issues }),
        () => active && setState({ status: 'error' }),
      );
    };
    load();
    const unsubscribe = onSubmissionsChanged(load);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [db, scope, period]);

  return state;
}

export function useSyncStatus(engine: SubmissionEngine): SyncStatus {
  return useSyncExternalStore(
    (onChange) => engine.onSyncStatus(() => onChange()),
    () => engine.getSyncStatus(),
  );
}
