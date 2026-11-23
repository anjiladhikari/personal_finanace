import { requireOptionalNativeModule } from 'expo';

export interface AuthorizeRequest {
  readonly scopes: readonly string[];
  /** Account to authorize silently/without a chooser; null lets Google decide. */
  readonly accountEmail: string | null;
  /** May show Google's consent / account screens. */
  readonly interactive: boolean;
  /** Always show the account chooser (switching or re-selecting accounts). */
  readonly selectAccount: boolean;
}

export type AuthorizeOutcome =
  | { readonly type: 'success'; readonly accessToken: string; readonly grantedScopes: readonly string[] }
  | { readonly type: 'cancelled' }
  /** Only for non-interactive requests: consent is needed (first use or revoked). */
  | { readonly type: 'needs_user_interaction' };

export type AuthorizationErrorKind = 'unavailable' | 'network' | 'misconfigured' | 'failed';

/** Fixed, non-personal messages only. */
export class AuthorizationError extends Error {
  readonly kind: AuthorizationErrorKind;

  constructor(kind: AuthorizationErrorKind) {
    super(`Google authorization error: ${kind}`);
    this.name = 'AuthorizationError';
    this.kind = kind;
  }
}

/**
 * Obtains Google API access tokens. Tokens are cached and refreshed by the
 * platform SDK (Google Play services on Android) and are never persisted by
 * the app.
 */
export interface GoogleAuthorizer {
  /** False when the native module is absent (Expo Go, iOS before V2). */
  readonly available: boolean;
  authorize(request: AuthorizeRequest): Promise<AuthorizeOutcome>;
  /** Drops a cached token so the next authorize() fetches a fresh one. */
  clearToken(accessToken: string): Promise<void>;
  /** Revokes every scope this app holds for the account. */
  revokeAccess(accountEmail: string, scopes: readonly string[]): Promise<void>;
}

interface NativeGoogleAuthorization {
  authorize(
    scopes: string[],
    accountEmail: string | null,
    interactive: boolean,
    selectAccount: boolean,
  ): Promise<unknown>;
  clearToken(accessToken: string): Promise<void>;
  revokeAccess(accountEmail: string, scopes: string[]): Promise<void>;
}

function errorKindFor(error: unknown): AuthorizationErrorKind {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'ERR_NETWORK') return 'network';
  if (code === 'ERR_DEVELOPER_ERROR') return 'misconfigured';
  return 'failed';
}

function parseOutcome(value: unknown): AuthorizeOutcome {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    throw new AuthorizationError('failed');
  }
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case 'cancelled':
      return { type: 'cancelled' };
    case 'needs_user_interaction':
      return { type: 'needs_user_interaction' };
    case 'success': {
      const { accessToken, grantedScopes } = record;
      if (typeof accessToken !== 'string' || accessToken === '' || !Array.isArray(grantedScopes)) {
        throw new AuthorizationError('failed');
      }
      return {
        type: 'success',
        accessToken,
        grantedScopes: grantedScopes.filter((s): s is string => typeof s === 'string'),
      };
    }
    default:
      throw new AuthorizationError('failed');
  }
}

export function createNativeAuthorizer(
  native: NativeGoogleAuthorization | null = requireOptionalNativeModule<NativeGoogleAuthorization>(
    'ExpoGoogleAuthorization',
  ),
): GoogleAuthorizer {
  const requireNative = (): NativeGoogleAuthorization => {
    if (native === null) throw new AuthorizationError('unavailable');
    return native;
  };

  return {
    available: native !== null,
    async authorize(request) {
      const module = requireNative();
      let raw: unknown;
      try {
        raw = await module.authorize(
          [...request.scopes],
          request.accountEmail,
          request.interactive,
          request.selectAccount,
        );
      } catch (error) {
        throw new AuthorizationError(errorKindFor(error));
      }
      return parseOutcome(raw);
    },
    async clearToken(accessToken) {
      try {
        await requireNative().clearToken(accessToken);
      } catch (error) {
        if (error instanceof AuthorizationError) throw error;
        throw new AuthorizationError(errorKindFor(error));
      }
    },
    async revokeAccess(accountEmail, scopes) {
      try {
        await requireNative().revokeAccess(accountEmail, [...scopes]);
      } catch (error) {
        if (error instanceof AuthorizationError) throw error;
        throw new AuthorizationError(errorKindFor(error));
      }
    },
  };
}
