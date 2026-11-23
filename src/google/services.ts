import { createNativeAuthorizer, type GoogleAuthorizer } from './authorization';
import type { FetchLike } from './http';

export interface GoogleServices {
  readonly authorizer: GoogleAuthorizer;
  readonly fetch: FetchLike;
}

/** Production wiring: the native AuthorizationClient module and global fetch. */
export function createDefaultGoogleServices(): GoogleServices {
  return {
    authorizer: createNativeAuthorizer(),
    fetch: (url, init) => fetch(url, init),
  };
}
