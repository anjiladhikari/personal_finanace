import { SQLiteProvider, useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { Suspense, useMemo, type ReactNode } from 'react';

import { diagnosticCodeFor, logDiagnostic } from '@/diagnostics/log';
import { AppErrorBoundary } from '@/ui/AppErrorBoundary';
import { LoadingScreen } from '@/ui/LoadingScreen';

import { DatabaseContext } from './DatabaseContext';
import { fromExpoDatabase } from './expoDatabase';
import { migrateDatabase } from './migrations';

export const DATABASE_NAME = 'expenses.db';

/** Runs once per app launch, before any screen can read the database. */
async function initializeDatabase(db: SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL');
  try {
    const result = await migrateDatabase(fromExpoDatabase(db));
    if (result.applied > 0) {
      logDiagnostic('db.migrated', {
        fromVersion: result.fromVersion,
        toVersion: result.toVersion,
        applied: result.applied,
      });
    }
  } catch (error) {
    logDiagnostic('db.migration_failed', { code: diagnosticCodeFor(error) });
    throw error;
  }
}

function ExpoDatabaseBridge({ children }: { children: ReactNode }) {
  const expoDb = useSQLiteContext();
  const db = useMemo(() => fromExpoDatabase(expoDb), [expoDb]);
  return <DatabaseContext.Provider value={db}>{children}</DatabaseContext.Provider>;
}

/**
 * Opens and migrates the on-device database before rendering children. Only
 * local storage is touched here; nothing waits on the network.
 */
export function DatabaseProvider({ children }: { children: ReactNode }) {
  return (
    <AppErrorBoundary>
      <Suspense fallback={<LoadingScreen />}>
        <SQLiteProvider databaseName={DATABASE_NAME} onInit={initializeDatabase} useSuspense>
          <ExpoDatabaseBridge>{children}</ExpoDatabaseBridge>
        </SQLiteProvider>
      </Suspense>
    </AppErrorBoundary>
  );
}
