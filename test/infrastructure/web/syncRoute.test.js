import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../../../src/infrastructure/web/app.js';
import { SyncController } from '../../../src/infrastructure/web/controllers/SyncController.js';

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

const passAuth = (req, _res, next) => { req.larkAppId = 'a'; req.larkAppSecret = 's'; next(); };
const fakeEnqueue = { async execute({ year }) { return { year, jobId: 1, status: 'ready' }; } };
const appWith = (enqueueFullSync = fakeEnqueue) => createApp({
  larkAuth: passAuth,
  baseController: { init: (_r, res) => res.status(404).end(), removePartitions: (_r, res) => res.status(404).end(), status: (_r, res) => res.status(404).end() },
  syncController: new SyncController({ enqueueFullSync, getFullSyncStatus: { execute: async () => ({}) } }),
});

test('POST /sync/full 400 when year missing', async () => {
  const r = await request(appWith(), { method: 'POST', path: '/sync/full', body: {} });
  assert.equal(r.status, 400);
});

test('POST /sync/full 202 with job summary', async () => {
  const r = await request(appWith(), { method: 'POST', path: '/sync/full', body: { year: 2024 } });
  assert.equal(r.status, 202);
  assert.equal(r.body.jobId, 1);
});

test('GET /sync/full/status 400 when year query param missing', async () => {
  const r = await request(appWith(), { method: 'GET', path: '/sync/full/status' });
  assert.equal(r.status, 400);
});

test('GET /sync/full/status 200 with the use-case result', async () => {
  const getFullSyncStatus = { execute: async ({ year }) => ({ year, jobStatus: 'claimed', jobId: 7, attempts: 0, checkpoint: null, lastRunAt: null }) };
  const app = createApp({
    larkAuth: passAuth,
    baseController: { init: (_r, res) => res.status(404).end(), removePartitions: (_r, res) => res.status(404).end(), status: (_r, res) => res.status(404).end() },
    syncController: new SyncController({ enqueueFullSync: fakeEnqueue, getFullSyncStatus }),
  });
  const r = await request(app, { method: 'GET', path: '/sync/full/status?year=2024' });
  assert.equal(r.status, 200);
  assert.equal(r.body.jobStatus, 'claimed');
  assert.equal(r.body.jobId, 7);
});
