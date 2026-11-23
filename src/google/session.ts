import type { GoogleAuthorizer } from './authorization';
import { googleRequest, GoogleApiError, type FetchLike, type GoogleRequest } from './http';
import { REQUIRED_SCOPES } from './scopes';

/** The stored grant no longer works without the user seeing Google's screens. */
export class ReconnectRequiredError extends Error {
  constructor() {
    super('Google access must be granted again');
    this.name = 'ReconnectRequiredError';
  }
}

export interface SessionServices {
  readonly authorizer: GoogleAuthorizer;
  readonly fetch: FetchLike;
}

/**
 * Makes Google API calls with an access token, transparently replacing an
 * expired token once (clear cached token → silent re-authorization → retry).
 */
export class GoogleSession {
  private accessToken: string;
  private accountEmail: string | null;

  constructor(
    private readonly services: SessionServices,
    accessToken: string,
    accountEmail: string | null,
  ) {
    this.accessToken = accessToken;
    this.accountEmail = accountEmail;
  }

  setAccountEmail(email: string): void {
    this.accountEmail = email;
  }

  async request<T>(request: GoogleRequest): Promise<T> {
    try {
      return await googleRequest<T>(this.services.fetch, this.accessToken, request);
    } catch (error) {
      if (!(error instanceof GoogleApiError) || error.kind !== 'unauthorized') throw error;
    }

    await this.refreshToken();
    try {
      return await googleRequest<T>(this.services.fetch, this.accessToken, request);
    } catch (error) {
      if (error instanceof GoogleApiError && error.kind === 'unauthorized') {
        throw new ReconnectRequiredError();
      }
      throw error;
    }
  }

  private async refreshToken(): Promise<void> {
    try {
      await this.services.authorizer.clearToken(this.accessToken);
    } catch {
      // A stale cache entry only costs one more 401; keep going.
    }
    const outcome = await this.services.authorizer.authorize({
      scopes: REQUIRED_SCOPES,
      accountEmail: this.accountEmail,
      interactive: false,
      selectAccount: false,
    });
    if (outcome.type !== 'success') throw new ReconnectRequiredError();
    this.accessToken = outcome.accessToken;
  }
}
