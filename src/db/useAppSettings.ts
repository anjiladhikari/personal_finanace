import { useEffect, useState } from 'react';

import { getAppSettings, type AppSettings } from './appSettings';
import { useDatabase } from './DatabaseContext';

export type AppSettingsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly settings: AppSettings }
  | { readonly status: 'error' };

/** Reads app_settings from the local database (never from the network). */
export function useAppSettings(): AppSettingsState {
  const db = useDatabase();
  const [state, setState] = useState<AppSettingsState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    getAppSettings(db).then(
      (settings) => active && setState({ status: 'ready', settings }),
      () => active && setState({ status: 'error' }),
    );
    return () => {
      active = false;
    };
  }, [db]);

  return state;
}
