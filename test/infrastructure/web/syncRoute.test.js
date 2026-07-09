import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../../../src/infrastructure/web/app.js';
import { SyncController } from '../../../src/infrastructure/web/controllers/SyncController.js';
import { YearsNotProvisionedError } from '../../../src/domain/errors.js';

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

test('GET /sync/full/check 400 when year query param missing', async () => {
  const app = createApp({
    larkAuth: passAuth,
    baseController: { init: (_r, res) => res.status(404).end(), removePartitions: (_r, res) => res.status(404).end(), status: (_r, res) => res.status(404).end() },
    syncController: new SyncController({ enqueueFullSync: fakeEnqueue, getFullSyncStatus: { execute: async () => ({}) }, checkFullSync: { execute: async () => ({}) } }),
  });
  const r = await request(app, { method: 'GET', path: '/sync/full/check' });
  assert.equal(r.status, 400);
});

test('GET /sync/full/check 200 with the use-case result', async () => {
  const checkFullSync = { execute: async ({ year }) => ({ year, done: true, partitionsChecked: 250, partitionsTotal: 250, findings: [] }) };
  const app = createApp({
    larkAuth: passAuth,
    baseController: { init: (_r, res) => res.status(404).end(), removePartitions: (_r, res) => res.status(404).end(), status: (_r, res) => res.status(404).end() },
    syncController: new SyncController({ enqueueFullSync: fakeEnqueue, getFullSyncStatus: { execute: async () => ({}) }, checkFullSync }),
  });
  const r = await request(app, { method: 'GET', path: '/sync/full/check?year=2024' });
  assert.equal(r.status, 200);
  assert.equal(r.body.done, true);
  assert.deepEqual(r.body.findings, []);
});

test('POST /sync/incremental 200 with the use-case summary', async () => {
  const runIncrementalSync = { execute: async ({ gateway }) => ({ since: '2026-07-03 00:00:00', newWatermark: '2026-07-03 11:45:00', scanned: 3, inserted: 1, updated: 1, skipped: 1 }) };
  const app = createApp({
    larkAuth: passAuth,
    baseController: { init: (_r, res) => res.status(404).end(), removePartitions: (_r, res) => res.status(404).end(), status: (_r, res) => res.status(404).end() },
    syncController: new SyncController({ enqueueFullSync: fakeEnqueue, getFullSyncStatus: { execute: async () => ({}) }, runIncrementalSync }),
  });
  const r = await request(app, { method: 'POST', path: '/sync/incremental', body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.scanned, 3);
  assert.equal(r.body.inserted, 1);
  assert.equal(r.body.newWatermark, '2026-07-03 11:45:00');
});

test('POST /sync/hard-full 400 when confirm is not true', async () => {
  const enqueueHardFullSync = { execute: async () => { throw new Error('must not run without confirm'); } };
  const app = createApp({
    larkAuth: passAuth,
    baseController: { init: (_r, res) => res.status(404).end(), removePartitions: (_r, res) => res.status(404).end(), status: (_r, res) => res.status(404).end() },
    syncController: new SyncController({ enqueueFullSync: fakeEnqueue, getFullSyncStatus: { execute: async () => ({}) }, enqueueHardFullSync }),
  });
  const r = await request(app, { method: 'POST', path: '/sync/hard-full', body: { year: 2026 } });
  assert.equal(r.status, 400);
});

test('POST /sync/hard-full 202 with the job summary when confirmed', async () => {
  const enqueueHardFullSync = { execute: async ({ year }) => ({ year, jobId: 42, status: 'ready' }) };
  const app = createApp({
    larkAuth: passAuth,
    baseController: { init: (_r, res) => res.status(404).end(), removePartitions: (_r, res) => res.status(404).end(), status: (_r, res) => res.status(404).end() },
    syncController: new SyncController({ enqueueFullSync: fakeEnqueue, getFullSyncStatus: { execute: async () => ({}) }, enqueueHardFullSync }),
  });
  const r = await request(app, { method: 'POST', path: '/sync/hard-full', body: { year: 2026, confirm: true } });
  assert.equal(r.status, 202);
  assert.equal(r.body.jobId, 42);
});

test('POST /sync/clear-partitions 400 when confirm is not true', async () => {
  const enqueueClearPartitions = { execute: async () => { throw new Error('must not run without confirm'); } };
  const app = createApp({
    larkAuth: passAuth,
    baseController: { init: (_r, res) => res.status(404).end(), removePartitions: (_r, res) => res.status(404).end(), status: (_r, res) => res.status(404).end() },
    syncController: new SyncController({ enqueueFullSync: fakeEnqueue, getFullSyncStatus: { execute: async () => ({}) }, enqueueClearPartitions }),
  });
  const r = await request(app, { method: 'POST', path: '/sync/clear-partitions', body: { year: 2026 } });
  assert.equal(r.status, 400);
});

test('POST /sync/clear-partitions 202 with the job summary when confirmed', async () => {
  const enqueueClearPartitions = { execute: async ({ year }) => ({ year, jobId: 77, status: 'ready' }) };
  const app = createApp({
    larkAuth: passAuth,
    baseController: { init: (_r, res) => res.status(404).end(), removePartitions: (_r, res) => res.status(404).end(), status: (_r, res) => res.status(404).end() },
    syncController: new SyncController({ enqueueFullSync: fakeEnqueue, getFullSyncStatus: { execute: async () => ({}) }, enqueueClearPartitions }),
  });
  const r = await request(app, { method: 'POST', path: '/sync/clear-partitions', body: { year: 2026, confirm: true } });
  assert.equal(r.status, 202);
  assert.equal(r.body.jobId, 77);
});

test('POST /sync/incremental 409 with the missing years when a year is unprovisioned', async () => {
  const runIncrementalSync = { execute: async () => { throw new YearsNotProvisionedError([2015, 2027]); } };
  const app = createApp({
    larkAuth: passAuth,
    baseController: { init: (_r, res) => res.status(404).end(), removePartitions: (_r, res) => res.status(404).end(), status: (_r, res) => res.status(404).end() },
    syncController: new SyncController({ enqueueFullSync: fakeEnqueue, getFullSyncStatus: { execute: async () => ({}) }, runIncrementalSync }),
  });
  const r = await request(app, { method: 'POST', path: '/sync/incremental', body: {} });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.years, [2015, 2027]);
});

test('POST /sync/full/heal 400 when year missing', async () => {
  const app = createApp({
    larkAuth: passAuth,
    baseController: { init: (_r, res) => res.status(404).end(), removePartitions: (_r, res) => res.status(404).end(), status: (_r, res) => res.status(404).end() },
    syncController: new SyncController({ enqueueFullSync: fakeEnqueue, getFullSyncStatus: { execute: async () => ({}) }, healFullSync: { execute: async () => ({}) } }),
  });
  const r = await request(app, { method: 'POST', path: '/sync/full/heal', body: {} });
  assert.equal(r.status, 400);
});

test('POST /sync/full/heal 200 with the use-case result', async () => {
  const healFullSync = { execute: async ({ year }) => ({ year, done: true, partitionsProcessed: 250, partitionsTotal: 250, actionsTaken: [{ partitionNo: 10, larkTableId: 'tbl10', orphansDeleted: 2, recordsRecreated: 0 }] }) };
  const app = createApp({
    larkAuth: passAuth,
    baseController: { init: (_r, res) => res.status(404).end(), removePartitions: (_r, res) => res.status(404).end(), status: (_r, res) => res.status(404).end() },
    syncController: new SyncController({ enqueueFullSync: fakeEnqueue, getFullSyncStatus: { execute: async () => ({}) }, healFullSync }),
  });
  const r = await request(app, { method: 'POST', path: '/sync/full/heal', body: { year: 2024 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.done, true);
  assert.equal(r.body.actionsTaken[0].orphansDeleted, 2);
});
