import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenCache } from '../../../src/infrastructure/lark/tokenCache.js';
import { LarkAuthError } from '../../../src/domain/errors.js';

function fakeFetch(responder) {
  const fn = async (url, opts) => {
    fn.calls.push({ url, opts });
    return { async json() { return responder(fn.calls.length); } };
  };
  fn.calls = [];
  return fn;
}

test('exchanges and caches token by appId', async () => {
  const fetchFn = fakeFetch(() => ({ code: 0, tenant_access_token: 't-1', expire: 7200 }));
  const cache = createTokenCache({ baseDomain: 'https://x', fetchFn, now: () => 1000 });
  assert.equal(await cache.getToken('app', 'sec'), 't-1');
  assert.equal(await cache.getToken('app', 'sec'), 't-1');
  assert.equal(fetchFn.calls.length, 1); // second call served from cache
});

test('throws LarkAuthError on non-zero code', async () => {
  const fetchFn = fakeFetch(() => ({ code: 10003, msg: 'bad secret' }));
  const cache = createTokenCache({ baseDomain: 'https://x', fetchFn, now: () => 1000 });
  await assert.rejects(() => cache.getToken('app', 'bad'), LarkAuthError);
});
