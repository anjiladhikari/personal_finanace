/**
 * The database surface the app uses. Production code adapts expo-sqlite to
 * it (expoDatabase.ts); tests adapt better-sqlite3 so real SQL runs in Jest.
 *
 * Every data statement takes bound parameters. `execScript` exists only for
 * constant schema/pragma text and must never receive user data.
 */

export type SqlValue = string | number | null;
export type SqlParams = readonly SqlValue[];

export interface SqlRunResult {
  readonly changes: number;
  readonly lastInsertRowId: number;
}

export interface SqlDatabase {
  /** Runs constant SQL without parameters (migrations and pragmas only). */
  execScript(sql: string): Promise<void>;
  run(sql: string, params?: SqlParams): Promise<SqlRunResult>;
  getFirst<T>(sql: string, params?: SqlParams): Promise<T | null>;
  getAll<T>(sql: string, params?: SqlParams): Promise<T[]>;
  /**
   * Runs `task` in an exclusive transaction that only contains the task's
   * own statements. Commits when it resolves; rolls back if it throws.
   */
  transaction(task: (tx: SqlDatabase) => Promise<void>): Promise<void>;
}
