import { googleRequest, GoogleApiError, type FetchLike, type RequestInitLike } from './http';

function fetchReturning(status: number, body: unknown): { fetch: FetchLike; calls: { url: string; init: RequestInitLike }[] } {
  const calls: { url: string; init: RequestInitLike }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      };
    },
  };
}

const googleError = (status: number, reason: string) => ({
  error: { code: status, message: 'File "Dinner with Sam" not found', errors: [{ reason }] },
});

async function errorOf(promise: Promise<unknown>): Promise<GoogleApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GoogleApiError) return error;
    throw error;
  }
  throw new Error('expected a GoogleApiError');
}

describe('googleRequest', () => {
  test('sends the bearer token and JSON body, and parses the reply', async () => {
    const { fetch, calls } = fetchReturning(200, { id: 'abc' });
    const result = await googleRequest<{ id: string }>(fetch, 'token-1', {
      method: 'POST',
      url: 'https://example.test/files',
      body: { name: 'My Expenses' },
    });
    expect(result).toEqual({ id: 'abc' });
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer token-1', 'Content-Type': 'application/json' },
      body: '{"name":"My Expenses"}',
    });
  });

  test('treats an empty success body as an empty object', async () => {
    const { fetch } = fetchReturning(200, '');
    await expect(googleRequest(fetch, 't', { method: 'GET', url: 'https://x.test' })).resolves.toEqual({});
  });

  test.each([
    [401, 'authError', 'unauthorized'],
    [403, 'insufficientPermissions', 'forbidden'],
    [403, 'rateLimitExceeded', 'rate_limited'],
    [403, 'userRateLimitExceeded', 'rate_limited'],
    [429, 'RESOURCE_EXHAUSTED', 'rate_limited'],
    [404, 'notFound', 'not_found'],
    [400, 'badRequest', 'bad_request'],
    [500, 'backendError', 'server'],
    [503, 'backendError', 'server'],
  ])('HTTP %i (%s) → %s', async (status, reason, kind) => {
    const { fetch } = fetchReturning(status, googleError(status, reason));
    const error = await errorOf(googleRequest(fetch, 't', { method: 'GET', url: 'https://x.test' }));
    expect(error).toMatchObject({ kind, status, reason });
  });

  test('errors never carry response text', async () => {
    const { fetch } = fetchReturning(404, googleError(404, 'notFound'));
    const error = await errorOf(googleRequest(fetch, 'secret-token', { method: 'GET', url: 'https://x.test' }));
    expect(`${error.message} ${String(error.reason)}`).not.toMatch(/Dinner|Sam|secret-token/);
  });

  test('ignores reason strings that are not plain codes', async () => {
    const { fetch } = fetchReturning(400, { error: { errors: [{ reason: 'bad reason with spaces@x' }] } });
    const error = await errorOf(googleRequest(fetch, 't', { method: 'GET', url: 'https://x.test' }));
    expect(error.reason).toBeNull();
  });

  test('network failures and unparseable replies are classified', async () => {
    const failing: FetchLike = async () => {
      throw new TypeError('Network request failed');
    };
    expect(await errorOf(googleRequest(failing, 't', { method: 'GET', url: 'https://x.test' }))).toMatchObject({
      kind: 'network',
      status: null,
    });
    const { fetch } = fetchReturning(200, '<html>');
    expect(await errorOf(googleRequest(fetch, 't', { method: 'GET', url: 'https://x.test' }))).toMatchObject({
      kind: 'invalid_response',
    });
  });

  test('aborts and reports a timeout', async () => {
    jest.useFakeTimers();
    try {
      const hanging: FetchLike = (_url, init) =>
        new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      const pending = errorOf(googleRequest(hanging, 't', { method: 'GET', url: 'https://x.test', timeoutMs: 5_000 }));
      await jest.advanceTimersByTimeAsync(5_001);
      expect(await pending).toMatchObject({ kind: 'timeout' });
    } finally {
      jest.useRealTimers();
    }
  });
});
