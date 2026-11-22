import * as Crypto from 'expo-crypto';
import * as Network from 'expo-network';

export interface PlatformServices {
  isOnline(): Promise<boolean>;
  /** Calls back when the device goes from offline to online. */
  onConnectivityRegained(callback: () => void): () => void;
  newId(): string;
  now(): number;
}

function online(state: { isConnected?: boolean; isInternetReachable?: boolean }): boolean {
  return state.isConnected !== false && state.isInternetReachable !== false;
}

export function createPlatformServices(): PlatformServices {
  return {
    async isOnline() {
      try {
        return online(await Network.getNetworkStateAsync());
      } catch {
        return true; // Unknown: let the request itself decide.
      }
    },
    onConnectivityRegained(callback) {
      let wasOnline: boolean | null = null;
      const subscription = Network.addNetworkStateListener((state) => {
        const isOnline = online(state);
        if (isOnline && wasOnline === false) callback();
        wasOnline = isOnline;
      });
      return () => subscription.remove();
    },
    newId: () => Crypto.randomUUID(),
    now: () => Date.now(),
  };
}
