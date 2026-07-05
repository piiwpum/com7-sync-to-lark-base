import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobQueue } from '../../../src/infrastructure/database/JobQueueMysql.js';

function fakeConnection(queryHandler) {
  const calls = [];
  // Ordered log of every call made on this connection, including the
  // transaction-control methods — lets tests verify not just that the
  // right queries ran, but that beginTransaction/commit/rollback/release
  // fired at the right points relative to them (and to each other).
  const events = [];
  return {
    calls,
    events,
    async query(sql, params) { calls.push({ sql, params }); events.push({ type: 'query', sql, params }); return queryHandler(sql, params); },
    async beginTransaction() { events.push({ type: 'beginTransaction' }); },
    async commit() { events.push({ type: 'commit' }); },
    async rollback() { events.push({ type: 'rollback' }); },
    release() { events.push({ type: 'release' }); },
  };
}
function fakePool(connection) {
  return { async getConnection() { return connection; }, async query(sql, params) { return connection.query(sql, params); } };
}

test('enqueue inserts a ready job with year/partitionNo columns and payload', async () => {
  const conn = fakeConnection(() => [{ insertId: 42 }]);
  const jq = createJobQueue(fakePool(conn));
  const id = await jq.enqueue({ type: 'full_sync', year: 2024, payload: { appId: 'a' } });
  assert.equal(id, 42);
  assert.match(conn.calls[0].sql, /INSERT INTO job_queue/);
  const [, , , , runAfterParam] = conn.calls[0].params;
  assert.ok(runAfterParam instanceof Date);
  assert.deepEqual(conn.calls[0].params.slice(0, 4), ['full_sync', 2024, null, JSON.stringify({ appId: 'a' })]);
});

test('claim selects ready jobs with FOR UPDATE SKIP LOCKED and marks them claimed', async () => {
  const conn = fakeConnection((sql) => {
    if (sql.includes('SELECT')) {
      assert.match(sql, /FOR UPDATE SKIP LOCKED/);
      return [[{ id: 1, type: 'full_sync', year: 2024, partition_no: null, payload: { appId: 'a' }, status: 'ready', attempts: 0, run_after: null, created_at: null, claimed_at: null }]];
    }
    return [{}];
  });
  const jq = createJobQueue(fakePool(conn));
  const jobs = await jq.claim({ limit: 1 });
  assert.deepEqual(jobs, [{ id: 1, type: 'full_sync', year: 2024, partitionNo: null, payload: { appId: 'a' }, status: 'ready', attempts: 0, runAfter: null, createdAt: null, claimedAt: null }]);
  assert.ok(conn.calls.some((c) => c.sql.includes("SET status='claimed'")));
  // Transaction hygiene: begin before the SELECT/UPDATE queries, commit
  // after both and before release, no rollback on the happy path. This
  // sequence assertion would fail if commit() were dropped, or if
  // rollback()/release() were swapped in order.
  assert.deepEqual(conn.events.map((e) => e.type), ['beginTransaction', 'query', 'query', 'commit', 'release']);
  assert.equal(conn.events.filter((e) => e.type === 'commit').length, 1);
  assert.equal(conn.events.filter((e) => e.type === 'rollback').length, 0);
  assert.equal(conn.events.filter((e) => e.type === 'release').length, 1);
});

test('claim skips the UPDATE and still commits/releases when no rows are ready', async () => {
  const conn = fakeConnection((sql) => (sql.includes('SELECT') ? [[]] : [{}]));
  const jq = createJobQueue(fakePool(conn));
  const jobs = await jq.claim({ limit: 5 });
  assert.deepEqual(jobs, []);
  // Only the SELECT runs (no UPDATE since there were no rows), then commit
  // and release — no rollback, no leaked connection.
  assert.deepEqual(conn.events.map((e) => e.type), ['beginTransaction', 'query', 'commit', 'release']);
  assert.equal(conn.events.filter((e) => e.type === 'commit').length, 1);
  assert.equal(conn.events.filter((e) => e.type === 'rollback').length, 0);
  assert.equal(conn.events.filter((e) => e.type === 'release').length, 1);
});

test('claim rolls back and releases (never commits) when a query throws', async () => {
  const conn = fakeConnection((sql) => {
    if (sql.includes('SELECT')) throw new Error('boom');
    return [{}];
  });
  const jq = createJobQueue(fakePool(conn));
  await assert.rejects(() => jq.claim({ limit: 1 }), /boom/);
  assert.deepEqual(conn.events.map((e) => e.type), ['beginTransaction', 'query', 'rollback', 'release']);
  assert.equal(conn.events.filter((e) => e.type === 'commit').length, 0);
  assert.equal(conn.events.filter((e) => e.type === 'rollback').length, 1);
  assert.equal(conn.events.filter((e) => e.type === 'release').length, 1);
});

test('complete marks the job done, optionally overwriting payload', async () => {
  const conn = fakeConnection(() => [{}]);
  const jq = createJobQueue(fakePool(conn));
  await jq.complete({ id: 1, payload: { appId: 'a' } }); // secret scrubbed by caller before passing payload
  assert.match(conn.calls[0].sql, /status='done'/);
  assert.deepEqual(conn.calls[0].params, [JSON.stringify({ appId: 'a' }), 1]);
});

test('fail marks the job dead, optionally overwriting payload', async () => {
  const conn = fakeConnection(() => [{}]);
  const jq = createJobQueue(fakePool(conn));
  await jq.fail({ id: 1, payload: null });
  assert.match(conn.calls[0].sql, /status='dead'/);
  assert.deepEqual(conn.calls[0].params, [null, 1]);
});

test('retry increments attempts and reschedules to ready', async () => {
  const conn = fakeConnection(() => [{}]);
  const jq = createJobQueue(fakePool(conn));
  const runAfter = new Date('2026-07-03T10:05:00Z');
  await jq.retry({ id: 1, runAfter });
  assert.match(conn.calls[0].sql, /status='ready'/);
  assert.match(conn.calls[0].sql, /attempts = attempts \+ 1/);
  assert.deepEqual(conn.calls[0].params, [runAfter, 1]);
});

test('findActive returns null when no ready/claimed job exists for that type+year', async () => {
  const conn = fakeConnection(() => [[]]);
  const jq = createJobQueue(fakePool(conn));
  assert.equal(await jq.findActive({ type: 'full_sync', year: 2024 }), null);
});

test('findActive returns the existing job when one is ready or claimed', async () => {
  const conn = fakeConnection(() => [[{ id: 7, type: 'full_sync', year: 2024, partition_no: null, payload: null, status: 'claimed', attempts: 0, run_after: null, created_at: null, claimed_at: null }]]);
  const jq = createJobQueue(fakePool(conn));
  const job = await jq.findActive({ type: 'full_sync', year: 2024 });
  assert.equal(job.id, 7);
  assert.equal(job.status, 'claimed');
  assert.match(conn.calls[0].sql, /status IN \('ready','claimed'\)/);
});

test('findLatest returns the most recent job regardless of status', async () => {
  const conn = fakeConnection(() => [[{ id: 5, type: 'full_sync', year: 2024, partition_no: null, payload: null, status: 'done', attempts: 0, run_after: null, created_at: null, claimed_at: null }]]);
  const jq = createJobQueue(fakePool(conn));
  const job = await jq.findLatest({ type: 'full_sync', year: 2024 });
  assert.equal(job.status, 'done');
  assert.match(conn.calls[0].sql, /ORDER BY id DESC/);
});
