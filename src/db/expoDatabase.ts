import type { SQLiteDatabase } from 'expo-sqlite';

import type { SqlDatabase, SqlParams } from './sql';

function adapt(db: SQLiteDatabase, inTransaction: boolean): SqlDatabase {
  return {
    execScript: (sql) => db.execAsync(sql),
    run: (sql, params: SqlParams = []) => db.runAsync(sql, [...params]),
    getFirst: <T>(sql: string, params: SqlParams = []) => db.getFirstAsync<T>(sql, [...params]),
    getAll: <T>(sql: string, params: SqlParams = []) => db.getAllAsync<T>(sql, [...params]),
    transaction: (task) => {
      if (inTransaction) {
        return Promise.reject(new Error('Nested transactions are not supported'));
      }
      // withExclusiveTransactionAsync runs on its own connection, so queries
      // issued elsewhere in the app cannot join this transaction.
      return db.withExclusiveTransactionAsync((txn) => task(adapt(txn, true)));
    },
  };
}

export function fromExpoDatabase(db: SQLiteDatabase): SqlDatabase {
  return adapt(db, false);
}
