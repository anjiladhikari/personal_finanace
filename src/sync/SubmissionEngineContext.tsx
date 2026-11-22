import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { useDatabase } from '@/db/DatabaseContext';
import { useGoogleServices } from '@/google/GoogleServicesContext';

import { createPlatformServices } from './platform';
import { SubmissionEngine } from './submissions';

const SubmissionEngineContext = createContext<SubmissionEngine | null>(null);

/**
 * One engine per app process. Runs are triggered on launch, when the app
 * returns to the foreground, when connectivity returns, and by a timer for
 * backoff/reconciliation while the app is open. No background tasks.
 */
export function SubmissionEngineProvider({ children }: { children: ReactNode }) {
  const db = useDatabase();
  const google = useGoogleServices();
  const platform = useMemo(() => createPlatformServices(), []);
  const engine = useMemo(() => new SubmissionEngine({ db, ...google, ...platform }), [db, google, platform]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    engine.setScheduleListener((nextRunAt) => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (nextRunAt === null) return;
      timer = setTimeout(() => void engine.processQueue('timer'), Math.max(0, nextRunAt - platform.now()));
    });

    void engine.processQueue('startup');
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') void engine.processQueue('foreground');
    });
    const stopConnectivity = platform.onConnectivityRegained(() => void engine.processQueue('connectivity'));

    return () => {
      engine.setScheduleListener(null);
      if (timer !== null) clearTimeout(timer);
      appState.remove();
      stopConnectivity();
    };
  }, [engine, platform]);

  return <SubmissionEngineContext.Provider value={engine}>{children}</SubmissionEngineContext.Provider>;
}

export function useSubmissionEngine(): SubmissionEngine {
  const engine = useContext(SubmissionEngineContext);
  if (engine === null) throw new Error('useSubmissionEngine must be used inside SubmissionEngineProvider');
  return engine;
}
