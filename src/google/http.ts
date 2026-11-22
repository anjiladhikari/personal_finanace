/**
 * Minimal JSON-over-HTTPS client for Google REST APIs. Error objects carry
 * only the HTTP status and Google's machine-readable reason code; response
 * bodies (which can echo file names or values) are never copied into errors.
 */

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export interface RequestInitLike {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;

export type GoogleApiErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'server'
  | 'bad_request'
  | 'network'
  | 'timeout'
  | 'invalid_response';

export class GoogleApiError extends Error {
  readonly kind: GoogleApiErrorKind;
  readonly status: number | null;
  /** Google's error reason, e.g. "insufficientPermissions". Never personal data. */
  readonly reason: string | null;

  constructor(kind: GoogleApiErrorKind, status: number | null, reason: string | null) {
    super(`Google API error: ${kind}${status === null ? '' : ` (${status})`}`);
    this.name = 'GoogleApiError';
    this.kind = kind;
    this.status = status;
    this.reason = reason;
  }
}

export const DEFAULT_TIMEOUT_MS = 20_000;

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'RESOURCE_EXHAUSTED']);
const SAFE_REASON = /^[A-Za-z_]{1,64}$/;

function reasonFrom(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { errors?: { reason?: unknown }[]; status?: unknown } };
    const reason = parsed.error?.errors?.[0]?.reason ?? parsed.error?.status;
    return typeof reason === 'string' && SAFE_REASON.test(reason) ? reason : null;
  } catch {
    return null;
  }
}

function kindForStatus(status: number, reason: string | null): GoogleApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 429 || (status === 403 && reason !== null && RATE_LIMIT_REASONS.has(reason))) {
    return 'rate_limited';
  }
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'bad_request';
}

export interface GoogleRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  readonly url: string;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export async function googleRequest<T>(
  fetchImpl: FetchLike,
  accessToken: string,
  request: GoogleRequest,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: ResponseLike;
  let text: string;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: controller.signal,
    });
    text = await response.text();
  } catch {
    throw new GoogleApiError(timedOut ? 'timeout' : 'network', null, null);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const reason = reasonFrom(text);
    throw new GoogleApiError(kindForStatus(response.status, reason), response.status, reason);
  }
  if (text.trim() === '') return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GoogleApiError('invalid_response', response.status, null);
  }
}
