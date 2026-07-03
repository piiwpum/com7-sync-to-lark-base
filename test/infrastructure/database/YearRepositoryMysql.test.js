import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createYearRepository } from '../../../src/infrastructure/database/YearRepositoryMysql.js';

function fakePool(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return handler(sql, params);
    },
  };
}

test('getYear returns null when no row', async () => {
  const pool = fakePool(() => [[]]);
  const repo = createYearRepository(pool);
  assert.equal(await repo.getYear(2024), null);
});

test('getYear maps the row', async () => {
  const pool = fakePool(() => [[{ year: 2024, base_id: 'B', status: 'complete' }]]);
  const repo = createYearRepository(pool);
  assert.deepEqual(await repo.getYear(2024), { year: 2024, baseId: 'B', status: 'complete' });
});

test('upsertYear issues an upsert with the right params', async () => {
  const pool = fakePool(() => [{}]);
  const repo = createYearRepository(pool);
  await repo.upsertYear({ year: 2024, baseId: 'B', status: 'partial' });
  assert.match(pool.calls[0].sql, /INSERT INTO sync_year/);
  assert.match(pool.calls[0].sql, /ON DUPLICATE KEY UPDATE/);
  assert.deepEqual(pool.calls[0].params, [2024, 'B', 'partial']);
});

test('listPartitions maps rows, ordered', async () => {
  const pool = fakePool(() => [[
    { partition_no: 1, lark_table_id: 't1', fill_count: 0 },
    { partition_no: 2, lark_table_id: 't2', fill_count: 5 },
  ]]);
  const repo = createYearRepository(pool);
  assert.deepEqual(await repo.listPartitions(2024), [
    { partitionNo: 1, larkTableId: 't1', fillCount: 0 },
    { partitionNo: 2, larkTableId: 't2', fillCount: 5 },
  ]);
});

test('upsertPartitions is a no-op for an empty list', async () => {
  const pool = fakePool(() => [{}]);
  const repo = createYearRepository(pool);
  await repo.upsertPartitions(2024, []);
  assert.equal(pool.calls.length, 0);
});

test('upsertPartitions batches rows into one query', async () => {
  const pool = fakePool(() => [{}]);
  const repo = createYearRepository(pool);
  await repo.upsertPartitions(2024, [{ partitionNo: 1, larkTableId: 't1' }, { partitionNo: 2, larkTableId: 't2' }]);
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /INSERT INTO sync_partition/);
  assert.deepEqual(pool.calls[0].params, [[[2024, 1, 't1'], [2024, 2, 't2']]]);
});

test('deletePartitions is a no-op for an empty list', async () => {
  const pool = fakePool(() => [{}]);
  const repo = createYearRepository(pool);
  await repo.deletePartitions(2024, []);
  assert.equal(pool.calls.length, 0);
});

test('deletePartitions issues a DELETE with the right params', async () => {
  const pool = fakePool(() => [{}]);
  const repo = createYearRepository(pool);
  await repo.deletePartitions(2024, [1, 2, 3]);
  assert.match(pool.calls[0].sql, /DELETE FROM sync_partition/);
  assert.deepEqual(pool.calls[0].params, [2024, [1, 2, 3]]);
});
