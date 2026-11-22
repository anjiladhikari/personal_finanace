import Database from 'better-sqlite3';

import type { SqlDatabase } from '@/db/sql';

export interface TestDatabase {
  readonly db: SqlDatabase;
  readonly raw: Database.Database;
  close(): void;
}

/**
 * Real SQLite (via better-sqlite3) behind the app's SqlDatabase interface,
 * so migrations and queries are tested against an actual engine.
 * Pass a file path to simulate an app restart by closing and reopening.
 */
export function openTestDatabase(filename = ':memory:'): TestDatabase {
  const raw = new Database(filename);

  const adapt = (inTransaction: boolean): SqlDatabase => ({
    execScript: async (sql) => {
      raw.exec(sql);
    },
    run: async (sql, params = []) => {
      const result = raw.prepare(sql).run(...params);
      return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) };
    },
    getFirst: async <T>(sql: string, params: readonly (string | number | null)[] = []) =>
      (raw.prepare(sql).get(...params) as T | undefined) ?? null,
    getAll: async <T>(sql: string, params: readonly (string | number | null)[] = []) =>
      raw.prepare(sql).all(...params) as T[],
    transaction: async (task) => {
      if (inTransaction) throw new Error('Nested transactions are not supported');
      raw.exec('BEGIN EXCLUSIVE');
      try {
        await task(adapt(true));
        raw.exec('COMMIT');
      } catch (error) {
        if (raw.inTransaction) raw.exec('ROLLBACK');
        throw error;
      }
    },
  });

  return { db: adapt(false), raw, close: () => raw.close() };
}
