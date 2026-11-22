import { useCallback, useEffect, useRef, useState } from 'react';

import { useDatabase } from '@/db/DatabaseContext';
import { useGoogleServices } from '@/google/GoogleServicesContext';
import { connectGoogle, type ConnectionRequest, type ConnectionState } from '@/sync/connection';

export type ConnectionUiState =
  | { readonly status: 'idle' }
  | { readonly status: 'working' }
  | { readonly status: 'done'; readonly result: ConnectionState };

/** Runs connect/provision requests one at a time and exposes the latest result. */
export function useGoogleConnection() {
  const db = useDatabase();
  const services = useGoogleServices();
  const [ui, setUi] = useState<ConnectionUiState>({ status: 'idle' });
  const running = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(
    async (request: ConnectionRequest): Promise<ConnectionState | null> => {
      if (running.current) return null;
      running.current = true;
      setUi({ status: 'working' });
      try {
        const result = await connectGoogle({ db, ...services }, request);
        if (mounted.current) setUi({ status: 'done', result });
        return result;
      } finally {
        running.current = false;
      }
    },
    [db, services],
  );

  return { ui, run };
}
