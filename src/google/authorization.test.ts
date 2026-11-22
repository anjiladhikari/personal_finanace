import { AuthorizationError, createNativeAuthorizer } from './authorization';

const request = { scopes: ['openid', 'scope-b'], accountEmail: 'a@example.com', interactive: true, selectAccount: false };

function nativeReturning(value: unknown) {
  return {
    authorize: jest.fn(async () => value),
    clearToken: jest.fn(async () => undefined),
    revokeAccess: jest.fn(async () => undefined),
  };
}

function nativeThrowing(code: string) {
  const error = Object.assign(new Error('native failure'), { code });
  return {
    authorize: jest.fn(async () => {
      throw error;
    }),
    clearToken: jest.fn(async () => {
      throw error;
    }),
    revokeAccess: jest.fn(async () => undefined),
  };
}

describe('createNativeAuthorizer', () => {
  test('passes the request through and parses success', async () => {
    const native = nativeReturning({ type: 'success', accessToken: 'tok', grantedScopes: ['openid', 7] });
    const authorizer = createNativeAuthorizer(native);

    await expect(authorizer.authorize(request)).resolves.toEqual({
      type: 'success',
      accessToken: 'tok',
      grantedScopes: ['openid'],
    });
    expect(native.authorize).toHaveBeenCalledWith(['openid', 'scope-b'], 'a@example.com', true, false);
  });

  test.each([
    [{ type: 'cancelled' }, { type: 'cancelled' }],
    [{ type: 'needs_user_interaction' }, { type: 'needs_user_interaction' }],
  ])('maps %o', async (raw, expected) => {
    await expect(createNativeAuthorizer(nativeReturning(raw)).authorize(request)).resolves.toEqual(expected);
  });

  test.each([[{ type: 'success', accessToken: '' }], [{ type: 'weird' }], [null], ['nope']])(
    'rejects malformed native result %o',
    async (raw) => {
      await expect(createNativeAuthorizer(nativeReturning(raw)).authorize(request)).rejects.toMatchObject({
        kind: 'failed',
      });
    },
  );

  test.each([
    ['ERR_NETWORK', 'network'],
    ['ERR_DEVELOPER_ERROR', 'misconfigured'],
    ['ERR_API_8', 'failed'],
    ['ERR_NO_ACTIVITY', 'failed'],
  ])('native error %s → %s', async (code, kind) => {
    const authorizer = createNativeAuthorizer(nativeThrowing(code));
    await expect(authorizer.authorize(request)).rejects.toMatchObject({ kind });
    await expect(authorizer.clearToken('t')).rejects.toBeInstanceOf(AuthorizationError);
  });

  test('without the native module (Expo Go) it is unavailable', async () => {
    const authorizer = createNativeAuthorizer(null);
    expect(authorizer.available).toBe(false);
    await expect(authorizer.authorize(request)).rejects.toMatchObject({ kind: 'unavailable' });
  });
});
