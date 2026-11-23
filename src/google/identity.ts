import { GoogleApiError } from './http';
import type { GoogleSession } from './session';

export const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

export interface GoogleIdentity {
  /** OpenID subject: stable, never reused, survives email changes. */
  readonly accountId: string;
  readonly email: string;
}

export async function fetchIdentity(session: GoogleSession): Promise<GoogleIdentity> {
  const info = await session.request<{ sub?: unknown; email?: unknown }>({
    method: 'GET',
    url: USERINFO_URL,
  });
  if (typeof info.sub !== 'string' || info.sub === '' || typeof info.email !== 'string' || info.email === '') {
    throw new GoogleApiError('invalid_response', 200, null);
  }
  return { accountId: info.sub, email: info.email };
}
