import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { createDefaultGoogleServices, type GoogleServices } from './services';

const GoogleServicesContext = createContext<GoogleServices | null>(null);

export function GoogleServicesProvider({ children }: { children: ReactNode }) {
  const services = useMemo(() => createDefaultGoogleServices(), []);
  return <GoogleServicesContext.Provider value={services}>{children}</GoogleServicesContext.Provider>;
}

export function useGoogleServices(): GoogleServices {
  const services = useContext(GoogleServicesContext);
  if (services === null) throw new Error('useGoogleServices must be used inside GoogleServicesProvider');
  return services;
}
