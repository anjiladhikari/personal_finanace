/** Identity (stable account ID + email) and per-file Drive access. All non-sensitive. */
export const OPENID_SCOPE = 'openid';
export const EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const REQUIRED_SCOPES: readonly string[] = [OPENID_SCOPE, EMAIL_SCOPE, DRIVE_FILE_SCOPE];

/**
 * Google's consent screen lets users untick individual permissions, so the
 * granted list must be checked rather than assumed.
 */
export function hasDriveFileAccess(grantedScopes: readonly string[]): boolean {
  return grantedScopes.includes(DRIVE_FILE_SCOPE);
}
