import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSourceRepository } from '../../../src/infrastructure/database/SourceRepositoryMysql.js';

function fakePool(handler) {
  const calls = [];
  return { calls, async query(sql, params) { calls.push({ sql, params }); return [handler(sql, params)]; } };
}

test('fetchItecChunk converts CE year to BE and queries the CrTime range', async () => {
  const pool = fakePool(() => []);
  const repo = createSourceRepository(pool);
  await repo.fetchItecChunk({ year: 2024, afterCursor: null, limit: 200 });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /WHERE CrTime >= \? AND CrTime < \?/);
  assert.match(sql, /ORDER BY SellID, RowNo/);
  assert.match(sql, /LIMIT \?/);
  assert.equal(params[0], '2567-01-01 00:00:00'); // 2024 CE -> 2567 BE
  assert.equal(params[1], '2568-01-01 00:00:00');
});

test('fetchItecChunk with no cursor starts from (0, 0)', async () => {
  const pool = fakePool(() => []);
  const repo = createSourceRepository(pool);
  await repo.fetchItecChunk({ year: 2024, afterCursor: null, limit: 200 });
  const { params } = pool.calls[0];
  // [startBE, endBE, afterSellId, afterSellId, afterRowNo, limit]
  assert.deepEqual(params.slice(2), [0, 0, 0, 200]);
});

test('fetchItecChunk resumes from the given cursor', async () => {
  const pool = fakePool(() => []);
  const repo = createSourceRepository(pool);
  await repo.fetchItecChunk({ year: 2024, afterCursor: { sellId: 1008889, rowNo: 2 }, limit: 200 });
  const { params } = pool.calls[0];
  assert.deepEqual(params.slice(2), [1008889, 1008889, 2, 200]);
});

test('fetchItecChunk returns the rows mysql2 gives back, unmodified', async () => {
  const rows = [{ SellID: 1, RowNo: 1, SellBranch: 114 }];
  const pool = fakePool(() => rows);
  const repo = createSourceRepository(pool);
  const result = await repo.fetchItecChunk({ year: 2024, afterCursor: null, limit: 200 });
  assert.deepEqual(result, rows);
});

test('fetchChangedSince queries itec and itec-today with UTime >= BE(since), no LIMIT', async () => {
  const pool = fakePool(() => []);
  const repo = createSourceRepository(pool);
  await repo.fetchChangedSince({ since: '2026-07-03 00:00:00' });
  assert.equal(pool.calls.length, 2);
  for (const { sql } of pool.calls) {
    assert.match(sql, /FROM \?\? WHERE UTime >= \?/);
    assert.match(sql, /ORDER BY UTime, SellID, RowNo/);
    assert.doesNotMatch(sql, /LIMIT/); // unbounded — caller chunks in memory
  }
  assert.deepEqual(pool.calls[0].params, ['itec', '2569-07-03 00:00:00']); // +543y, same clock
  assert.deepEqual(pool.calls[1].params, ['itec-today', '2569-07-03 00:00:00']);
});

test('fetchChangedSince dedups a row present in both tables, keeping the newer UTime', async () => {
  const itecRow = { SellBranch: 114, SellID: 10, RowNo: 1, UTime: '2569-07-03 08:00:00' };
  const dailyRow = { SellBranch: 114, SellID: 10, RowNo: 1, UTime: '2569-07-03 09:30:00' }; // newer
  const other = { SellBranch: 114, SellID: 11, RowNo: 1, UTime: '2569-07-03 07:00:00' };
  const pool = fakePool((_sql, params) => (params[0] === 'itec' ? [itecRow, other] : [dailyRow]));
  const repo = createSourceRepository(pool);
  const rows = await repo.fetchChangedSince({ since: '2026-07-03 00:00:00' });
  // ordered ascending by UTime; dedup keeps the 09:30 daily row for key 114|10|1
  assert.deepEqual(rows, [other, dailyRow]);
});

test('fetchChangedSince returns the full merged set ordered by UTime (no cap)', async () => {
  const mk = (id, u) => ({ SellBranch: 1, SellID: id, RowNo: 1, UTime: u });
  const pool = fakePool((_sql, params) => (params[0] === 'itec'
    ? [mk(1, '2569-07-03 01:00:00'), mk(2, '2569-07-03 02:00:00')]
    : [mk(3, '2569-07-03 03:00:00')]));
  const repo = createSourceRepository(pool);
  const rows = await repo.fetchChangedSince({ since: '2026-07-03 00:00:00' });
  assert.deepEqual(rows.map((r) => r.SellID), [1, 2, 3]); // all rows, ascending
});

test('countItec converts CE year to BE and returns the row count', async () => {
  const pool = fakePool(() => [{ n: 1582452 }]);
  const repo = createSourceRepository(pool);
  const n = await repo.countItec(2022);
  const { sql, params } = pool.calls[0];
  assert.match(sql, /SELECT COUNT\(\*\) AS n FROM itec WHERE CrTime >= \? AND CrTime < \?/);
  assert.deepEqual(params, ['2565-01-01 00:00:00', '2566-01-01 00:00:00']); // 2022 CE -> 2565 BE
  assert.equal(n, 1582452);
});

test('fetchBySourceKeys queries (SellID, RowNo) IN (...) and filters by full derived key', async () => {
  const rows = [
    { SellID: 10, RowNo: 1, SellBranch: 114 }, // matches wanted key exactly
    { SellID: 10, RowNo: 1, SellBranch: 999 }, // same (SellID,RowNo) but wrong branch — must be filtered out
  ];
  const pool = fakePool(() => rows);
  const repo = createSourceRepository(pool);
  const result = await repo.fetchBySourceKeys({ sourceKeys: ['114|10|1'] });
  const { sql, params } = pool.calls[0];
  assert.match(sql, /WHERE \(SellID, RowNo\) IN \(\(\?,\?\)\)/);
  assert.deepEqual(params, [10, 1]);
  assert.deepEqual(result, [rows[0]]);
});

test('fetchBySourceKeys with an empty list does not query the database', async () => {
  const pool = fakePool(() => { throw new Error('should not be called'); });
  const repo = createSourceRepository(pool);
  assert.deepEqual(await repo.fetchBySourceKeys({ sourceKeys: [] }), []);
  assert.equal(pool.calls.length, 0);
});
