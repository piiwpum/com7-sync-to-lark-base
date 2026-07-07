import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMappingRepository } from '../../../src/infrastructure/database/MappingRepositoryMysql.js';

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

test('reserveSlots takes the whole count from one partition when it fits', async () => {
  const conn = fakeConnection((sql) => {
    if (sql.includes('SELECT')) return [[{ partition_no: 3, lark_table_id: 'tbl3', fill_count: 100 }]];
    return [{}];
  });
  const repo = createMappingRepository(fakePool(conn));
  const segments = await repo.reserveSlots({ year: 2024, count: 50 });
  assert.deepEqual(segments, [{ partitionNo: 3, larkTableId: 'tbl3', startIndex: 100, count: 50 }]);
  // Transaction hygiene: begin before the queries, commit after the UPDATE
  // and before release, no rollback on the happy path.
  assert.deepEqual(conn.events.map((e) => e.type), ['beginTransaction', 'query', 'query', 'commit', 'release']);
  assert.equal(conn.events.filter((e) => e.type === 'commit').length, 1);
  assert.equal(conn.events.filter((e) => e.type === 'rollback').length, 0);
  assert.equal(conn.events.filter((e) => e.type === 'release').length, 1);
});

test('reserveSlots splits across two partitions when the first is nearly full', async () => {
  let call = 0;
  const conn = fakeConnection((sql) => {
    if (sql.includes('SELECT')) {
      call++;
      if (call === 1) return [[{ partition_no: 3, lark_table_id: 'tbl3', fill_count: 49980 }]]; // 20 left
      return [[{ partition_no: 4, lark_table_id: 'tbl4', fill_count: 0 }]];
    }
    return [{}];
  });
  const repo = createMappingRepository(fakePool(conn));
  const segments = await repo.reserveSlots({ year: 2024, count: 50 });
  assert.deepEqual(segments, [
    { partitionNo: 3, larkTableId: 'tbl3', startIndex: 49980, count: 20 },
    { partitionNo: 4, larkTableId: 'tbl4', startIndex: 0, count: 30 },
  ]);
  // Two segments means two full transactions on this (reused) connection:
  // begin/query/query/commit/release, twice, each with its own commit and
  // release (no leaked connection, no rollback on either segment).
  assert.deepEqual(conn.events.map((e) => e.type), [
    'beginTransaction', 'query', 'query', 'commit', 'release',
    'beginTransaction', 'query', 'query', 'commit', 'release',
  ]);
  assert.equal(conn.events.filter((e) => e.type === 'commit').length, 2);
  assert.equal(conn.events.filter((e) => e.type === 'rollback').length, 0);
  assert.equal(conn.events.filter((e) => e.type === 'release').length, 2);
});

test('reserveSlots throws when no partition has capacity left', async () => {
  const conn = fakeConnection((sql) => (sql.includes('SELECT') ? [[]] : [{}]));
  const repo = createMappingRepository(fakePool(conn));
  await assert.rejects(() => repo.reserveSlots({ year: 2024, count: 10 }), /no partition capacity/);
  // The failed reservation must still roll back its transaction and
  // release the connection (no leak), and must never commit.
  assert.deepEqual(conn.events.map((e) => e.type), ['beginTransaction', 'query', 'rollback', 'release']);
  assert.equal(conn.events.filter((e) => e.type === 'commit').length, 0);
  assert.equal(conn.events.filter((e) => e.type === 'rollback').length, 1);
  assert.equal(conn.events.filter((e) => e.type === 'release').length, 1);
});

test('saveMappings is a no-op for an empty list', async () => {
  const conn = fakeConnection(() => [{}]);
  const repo = createMappingRepository(fakePool(conn));
  await repo.saveMappings([]);
  assert.equal(conn.calls.length, 0);
});

test('saveMappings batches an upsert with all mapping fields', async () => {
  const conn = fakeConnection(() => [{}]);
  const repo = createMappingRepository(fakePool(conn));
  await repo.saveMappings([{
    year: 2024, baseId: 'B', sourceKey: '114|1|2', partitionNo: 1, larkTableId: 'tbl1',
    larkRecordId: 'rec1', checksum: 123, crTime: '2026-05-14 07:12:43', uTime: '2026-05-14 07:12:43',
  }]);
  assert.match(conn.calls[0].sql, /INSERT INTO sync_mapping/);
  assert.match(conn.calls[0].sql, /ON DUPLICATE KEY UPDATE/);
  assert.deepEqual(conn.calls[0].params, [[[
    2024, 'B', '114|1|2', 1, 'tbl1', 'rec1', 123, '2026-05-14 07:12:43', '2026-05-14 07:12:43',
  ]]]);
});

test('getState returns null when no row exists', async () => {
  const conn = fakeConnection(() => [[]]);
  const repo = createMappingRepository(fakePool(conn));
  assert.equal(await repo.getState('full_sync:2024'), null);
});

test('getState maps the row including parsed checkpoint', async () => {
  const conn = fakeConnection(() => [[{
    scope: 'full_sync:2024', last_utime: null, last_id: null,
    checkpoint: { sellId: 5, rowNo: 1 }, last_run_at: '2026-07-03 10:00:00', status: 'running',
  }]]);
  const repo = createMappingRepository(fakePool(conn));
  const state = await repo.getState('full_sync:2024');
  assert.deepEqual(state, {
    scope: 'full_sync:2024', lastUtime: null, lastId: null,
    checkpoint: { sellId: 5, rowNo: 1 }, lastRunAt: '2026-07-03 10:00:00', status: 'running',
  });
});

test('setState upserts only the columns present in the patch', async () => {
  const conn = fakeConnection(() => [{}]);
  const repo = createMappingRepository(fakePool(conn));
  await repo.setState('full_sync:2024', { checkpoint: { sellId: 5, rowNo: 1 }, status: 'running' });
  assert.match(conn.calls[0].sql, /INSERT INTO sync_state/);
  assert.match(conn.calls[0].sql, /ON DUPLICATE KEY UPDATE/);
});

test('updatePartitionBoundary sets only first_* when no last is given', async () => {
  const conn = fakeConnection(() => [{}]);
  const repo = createMappingRepository(fakePool(conn));
  await repo.updatePartitionBoundary({
    year: 2024, partitionNo: 1,
    first: { larkRecordId: 'rec1', sourceKey: '114|1|1', crTime: '2026-01-01 00:00:00' },
  });
  assert.match(conn.calls[0].sql, /first_lark_record_id\s*=\s*\?/);
  assert.doesNotMatch(conn.calls[0].sql, /last_lark_record_id/);
  assert.deepEqual(conn.calls[0].params.slice(0, 3), ['rec1', '114|1|1', '2026-01-01 00:00:00']);
});

test('updatePartitionBoundary sets only last_* when no first is given', async () => {
  const conn = fakeConnection(() => [{}]);
  const repo = createMappingRepository(fakePool(conn));
  await repo.updatePartitionBoundary({
    year: 2024, partitionNo: 1,
    last: { larkRecordId: 'rec9', sourceKey: '114|9|1', crTime: '2026-01-02 00:00:00' },
  });
  assert.match(conn.calls[0].sql, /last_lark_record_id\s*=\s*\?/);
  assert.doesNotMatch(conn.calls[0].sql, /first_lark_record_id/);
});

test('updatePartitionBoundary sets both when a segment is both the first and only write', async () => {
  const conn = fakeConnection(() => [{}]);
  const repo = createMappingRepository(fakePool(conn));
  await repo.updatePartitionBoundary({
    year: 2024, partitionNo: 1,
    first: { larkRecordId: 'rec1', sourceKey: '114|1|1', crTime: '2026-01-01 00:00:00' },
    last: { larkRecordId: 'rec2', sourceKey: '114|1|2', crTime: '2026-01-01 00:00:01' },
  });
  assert.match(conn.calls[0].sql, /first_lark_record_id\s*=\s*\?/);
  assert.match(conn.calls[0].sql, /last_lark_record_id\s*=\s*\?/);
});

test('listPartitions returns every partition for a year, ordered, camelCased', async () => {
  const conn = fakeConnection(() => [[
    { partition_no: 1, lark_table_id: 'tbl1', fill_count: 50000 },
    { partition_no: 2, lark_table_id: 'tbl2', fill_count: 12345 },
  ]]);
  const repo = createMappingRepository(fakePool(conn));
  const partitions = await repo.listPartitions({ year: 2024 });
  assert.match(conn.calls[0].sql, /ORDER BY partition_no/);
  assert.deepEqual(conn.calls[0].params, [2024]);
  assert.deepEqual(partitions, [
    { partitionNo: 1, larkTableId: 'tbl1', fillCount: 50000 },
    { partitionNo: 2, larkTableId: 'tbl2', fillCount: 12345 },
  ]);
});

test('getMappingsForPartition returns source_key/lark_record_id pairs for one partition', async () => {
  const conn = fakeConnection(() => [[
    { source_key: '114|1|1', lark_record_id: 'rec1' },
    { source_key: '114|1|2', lark_record_id: 'rec2' },
  ]]);
  const repo = createMappingRepository(fakePool(conn));
  const mappings = await repo.getMappingsForPartition({ year: 2024, partitionNo: 10 });
  assert.deepEqual(conn.calls[0].params, [2024, 10]);
  assert.deepEqual(mappings, [
    { sourceKey: '114|1|1', larkRecordId: 'rec1' },
    { sourceKey: '114|1|2', larkRecordId: 'rec2' },
  ]);
});

test('setFillCount updates sync_partition.fill_count directly', async () => {
  const conn = fakeConnection(() => [{}]);
  const repo = createMappingRepository(fakePool(conn));
  await repo.setFillCount({ year: 2024, partitionNo: 10, fillCount: 49800 });
  assert.match(conn.calls[0].sql, /UPDATE sync_partition SET fill_count\s*=\s*\?/);
  assert.deepEqual(conn.calls[0].params, [49800, 2024, 10]);
});
