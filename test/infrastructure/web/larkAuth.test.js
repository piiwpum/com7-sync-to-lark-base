import { test } from 'node:test';
import assert from 'node:assert/strict';
import { larkAuth } from '../../../src/infrastructure/web/middlewares/larkAuth.js';
import { LarkAuthError } from '../../../src/domain/errors.js';

function res() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

test('401 when headers missing', async () => {
  const mw = larkAuth({ tokenCache: { getToken: async () => 't' }, createGateway: () => ({}), baseDomain: 'x' });
  const r = res();
  await mw({ headers: {} }, r, () => assert.fail('next should not run'));
  assert.equal(r.code, 401);
});

test('attaches req.larkGateway on success', async () => {
  const mw = larkAuth({
    tokenCache: { getToken: async () => 't-ok' },
    createGateway: ({ token }) => ({ token }),
    baseDomain: 'x',
  });
  const req = { headers: { 'x-lark-app-id': 'a', 'x-lark-app-secret': 's' } };
  let called = false;
  await mw(req, res(), () => { called = true; });
  assert.equal(called, true);
  assert.deepEqual(req.larkGateway, { token: 't-ok' });
});

test('401 on LarkAuthError', async () => {
  const mw = larkAuth({
    tokenCache: { getToken: async () => { throw new LarkAuthError('bad'); } },
    createGateway: () => ({}), baseDomain: 'x',
  });
  const r = res();
  await mw({ headers: { 'x-lark-app-id': 'a', 'x-lark-app-secret': 's' } }, r, () => assert.fail());
  assert.equal(r.code, 401);
});

test('attaches req.larkAppId and req.larkAppSecret alongside the gateway', async () => {
  const mw = larkAuth({
    tokenCache: { getToken: async () => 't-ok' },
    createGateway: ({ token }) => ({ token }),
    baseDomain: 'x',
  });
  const req = { headers: { 'x-lark-app-id': 'app-1', 'x-lark-app-secret': 'sec-1' } };
  await mw(req, res(), () => {});
  assert.equal(req.larkAppId, 'app-1');
  assert.equal(req.larkAppSecret, 'sec-1');
});
