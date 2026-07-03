import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../../../src/infrastructure/web/app.js';
import { BaseController } from '../../../src/infrastructure/web/controllers/BaseController.js';
import { YearNotProvisionedError } from '../../../src/domain/errors.js';

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
const fakeProvision = {
  async execute({ year, base }) {
    return { year, base, total: 250, existing: 0, created: 250, remaining: 0, done: true };
  },
};
function makeFakeRemove() {
  return {
    calls: [],
    async execute({ year, base, dryRun }) {
      this.calls.push({ dryRun });
      if (dryRun) return { year, base, total: 250, deleted: 0, remaining: 250, done: false, dryRun: true, tables: ['itec_001'] };
      return { year, base, total: 250, deleted: 250, remaining: 0, done: true };
    },
  };
}
function makeFakeStatus({ found = true } = {}) {
  return {
    async execute({ year }) {
      if (!found) throw new YearNotProvisionedError(year);
      return { year, base: 'B', status: 'complete', total: 250, existing: 250, missing: 0, complete: true };
    },
  };
}
const appWith = ({ removeAllPartitions = makeFakeRemove(), getBaseStatus = makeFakeStatus() } = {}) => createApp({
  larkAuth: passAuth,
  baseController: new BaseController({ provisionYearBase: fakeProvision, removeAllPartitions, getBaseStatus }),
});

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

test('remove-partitions: 400 when base missing', async () => {
  const r = await request(appWith(), { method: 'POST', path: '/base/remove-partitions', body: { year: 2023 } });
  assert.equal(r.status, 400);
});

test('remove-partitions: 200 with summary on success', async () => {
  const r = await request(appWith(), { method: 'POST', path: '/base/remove-partitions', body: { year: 2023, base: 'B' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted, 250);
  assert.equal(r.body.done, true);
});

test('remove-partitions: ?dryRun=true is forwarded and reflected in response', async () => {
  const removeAllPartitions = makeFakeRemove();
  const r = await request(appWith({ removeAllPartitions }), {
    method: 'POST', path: '/base/remove-partitions?dryRun=true', body: { year: 2023, base: 'B' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun, true);
  assert.deepEqual(r.body.tables, ['itec_001']);
  assert.deepEqual(removeAllPartitions.calls, [{ dryRun: true }]);
});

test('remove-partitions: without dryRun, execute() gets dryRun:false', async () => {
  const removeAllPartitions = makeFakeRemove();
  await request(appWith({ removeAllPartitions }), { method: 'POST', path: '/base/remove-partitions', body: { year: 2023, base: 'B' } });
  assert.deepEqual(removeAllPartitions.calls, [{ dryRun: false }]);
});

test('status: 400 when year query param missing/invalid', async () => {
  const r = await request(appWith(), { method: 'GET', path: '/base/status' });
  assert.equal(r.status, 400);
});

test('status: 404 when year not provisioned', async () => {
  const r = await request(appWith({ getBaseStatus: makeFakeStatus({ found: false }) }), {
    method: 'GET', path: '/base/status?year=2024',
  });
  assert.equal(r.status, 404);
});

test('status: 200 with summary when found', async () => {
  const r = await request(appWith(), { method: 'GET', path: '/base/status?year=2024' });
  assert.equal(r.status, 200);
  assert.equal(r.body.complete, true);
  assert.equal(r.body.total, 250);
});
