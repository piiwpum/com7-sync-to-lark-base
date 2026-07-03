import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../../../src/infrastructure/web/app.js';
import { BaseController } from '../../../src/infrastructure/web/controllers/BaseController.js';

function request(app, { method, path, headers, body }) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = http.request({ port, method, path, headers: { 'Content-Type': 'application/json', ...headers } }, (r) => {
        let data = '';
        r.on('data', (c) => (data += c));
        r.on('end', () => { server.close(); resolve({ status: r.statusCode, body: JSON.parse(data || '{}') }); });
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

const passAuth = (req, _res, next) => { req.larkGateway = {}; next(); };
const fakeUseCase = {
  async execute({ year, base }) {
    return { year, base, total: 250, existing: 0, created: 250, remaining: 0, done: true };
  },
};
const appWith = () => createApp({ larkAuth: passAuth, baseController: new BaseController({ provisionYearBase: fakeUseCase }) });

test('400 when year missing', async () => {
  const r = await request(appWith(), { method: 'POST', path: '/base/init', body: { base: 'B' } });
  assert.equal(r.status, 400);
});

test('200 with summary on success', async () => {
  const r = await request(appWith(), { method: 'POST', path: '/base/init', body: { year: 2024, base: 'B' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, 250);
  assert.equal(r.body.done, true);
});
