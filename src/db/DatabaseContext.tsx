import { createContext, useContext } from 'react';

import type { SqlDatabase } from './sql';

/**
 * The app's database handle. Production fills it from expo-sqlite
 * (DatabaseProvider); tests fill it with an in-memory SQLite database.
 */
export const DatabaseContext = createContext<SqlDatabase | null>(null);

export function useDatabase(): SqlDatabase {
  const db = useContext(DatabaseContext);
  if (db === null) throw new Error('useDatabase must be used inside DatabaseProvider');
  return db;
}
