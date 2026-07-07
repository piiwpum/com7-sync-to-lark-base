// test/application/RunFullSyncJob.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunFullSyncJob } from '../../src/application/use-cases/RunFullSyncJob.js';
import { crc32 } from '../../src/domain/services/checksum.js';
import { transformItecRow } from '../../src/domain/services/transformItecRow.js';

function row(sellId, rowNo, crTimeBE = '2569-01-01 00:00:00') {
  return { CrTime: crTimeBE, UTime: crTimeBE, SellID: sellId, SellBranch: 114, RowNo: rowNo, Product: 'P1' };
}

function makeDeps({
  chunks, reserveSlotsImpl, batchCreateImpl, initialCheckpoint = null,
  openPartition = null, countRecordsImpl, setFillCountImpl,
} = {}) {
  let chunkIndex = 0;
  const savedMappings = [];
  const stateWrites = [];
  const boundaryWrites = [];
  const fillCountWrites = [];
  const jobQueueCalls = { complete: [], fail: [], retry: [] };
  const tokenCalls = [];

  return {
    sourceRepository: {
      async fetchItecChunk() { return chunkIndex < chunks.length ? chunks[chunkIndex++] : []; },
    },
    mappingRepository: {
      async getState() { return initialCheckpoint ? { checkpoint: initialCheckpoint } : null; },
      async reserveSlots(q) { return reserveSlotsImpl ? reserveSlotsImpl(q) : [{ partitionNo: 1, larkTableId: 'tbl1', startIndex: 0, count: q.count }]; },
      async saveMappings(mappings) { savedMappings.push(...mappings); },
      async setState(scope, patch) { stateWrites.push({ scope, patch }); },
      async updatePartitionBoundary(q) { boundaryWrites.push(q); },
      async getOpenPartition() { return openPartition; },
      async setFillCount(q) { fillCountWrites.push(q); if (setFillCountImpl) await setFillCountImpl(q); },
    },
    yearRepository: { async getYear() { return { year: 2024, baseId: 'BASE1', status: 'complete' }; } },
    jobQueue: {
      async complete(q) { jobQueueCalls.complete.push(q); },
      async fail(q) { jobQueueCalls.fail.push(q); },
      async retry(q) { jobQueueCalls.retry.push(q); },
    },
    tokenCache: { async getToken(appId, appSecret) { tokenCalls.push({ appId, appSecret }); return 'tok'; } },
    createGateway: () => ({
      batchCreate: batchCreateImpl ?? (async ({ records }) => records.map((_r, i) => `rec${i}`)),
      countRecords: countRecordsImpl ?? (async () => { throw new Error('countRecords should not be called when there is no open partition'); }),
    }),
    baseDomain: 'https://x',
    chunkSize: 200,
    maxAttempts: 5,
    retryDelayMs: 60000,
    now: () => Date.parse('2026-07-03T10:00:00Z'),
    _inspect: { savedMappings, stateWrites, boundaryWrites, fillCountWrites, jobQueueCalls, tokenCalls },
  };
}

test('happy path: one chunk, completes the job and scrubs the secret', async () => {
  const deps = makeDeps({ chunks: [[row(1, 1), row(1, 2)]] });
  const uc = new RunFullSyncJob(deps);
  await uc.execute({ id: 1, year: 2024, attempts: 0, payload: { appId: 'a', appSecret: 's' } });

  assert.equal(deps._inspect.savedMappings.length, 2);
  assert.equal(deps._inspect.savedMappings[0].sourceKey, '114|1|1');
  assert.equal(deps._inspect.savedMappings[0].larkRecordId, 'rec0');
  assert.equal(deps._inspect.savedMappings[0].baseId, 'BASE1');
  assert.equal(deps._inspect.savedMappings[0].larkTableId, 'tbl1');
  assert.equal(
    deps._inspect.savedMappings[0].checksum,
    crc32(JSON.stringify(transformItecRow(row(1, 1)))),
  );

  assert.equal(deps._inspect.jobQueueCalls.complete.length, 1);
  assert.deepEqual(deps._inspect.jobQueueCalls.complete[0], { id: 1, payload: { appId: 'a' } }); // secret scrubbed

  const lastCheckpoint = deps._inspect.stateWrites.at(-1).patch.checkpoint;
  assert.deepEqual(lastCheckpoint, { sellId: 1, rowNo: 2 });
});

test('advances the cursor and stops when a chunk comes back empty', async () => {
  const deps = makeDeps({ chunks: [[row(1, 1)], [row(2, 1)], []] });
  const uc = new RunFullSyncJob(deps);
  await uc.execute({ id: 1, year: 2024, attempts: 0, payload: { appId: 'a', appSecret: 's' } });
  assert.equal(deps._inspect.savedMappings.length, 2);
  assert.equal(deps._inspect.jobQueueCalls.complete.length, 1);

  // Two non-empty chunks ran before the empty one stopped the loop, so a
  // fresh token must have been fetched once per chunk that actually ran —
  // not once for the whole job, and not once per row.
  assert.equal(deps._inspect.tokenCalls.length, 2);
  assert.deepEqual(deps._inspect.tokenCalls, [
    { appId: 'a', appSecret: 's' },
    { appId: 'a', appSecret: 's' },
  ]);
});

test('resumes from an existing checkpoint by passing it as afterCursor', async () => {
  let seenCursor;
  const deps = makeDeps({ chunks: [[]], initialCheckpoint: { sellId: 5, rowNo: 9 } });
  deps.sourceRepository.fetchItecChunk = async (q) => { seenCursor = q.afterCursor; return []; };
  const uc = new RunFullSyncJob(deps);
  await uc.execute({ id: 1, year: 2024, attempts: 0, payload: { appId: 'a', appSecret: 's' } });
  assert.deepEqual(seenCursor, { sellId: 5, rowNo: 9 });
});

test('splits a chunk across two reserved segments into two batchCreate calls', async () => {
  const calls = [];
  const deps = makeDeps({
    chunks: [[row(1, 1), row(1, 2), row(1, 3)]],
    reserveSlotsImpl: () => [
      { partitionNo: 1, larkTableId: 'tbl1', startIndex: 49998, count: 2 },
      { partitionNo: 2, larkTableId: 'tbl2', startIndex: 0, count: 1 },
    ],
    batchCreateImpl: async ({ tableId, records }) => { calls.push({ tableId, n: records.length }); return records.map((_r, i) => `${tableId}-rec${i}`); },
  });
  const uc = new RunFullSyncJob(deps);
  await uc.execute({ id: 1, year: 2024, attempts: 0, payload: { appId: 'a', appSecret: 's' } });
  assert.deepEqual(calls, [{ tableId: 'tbl1', n: 2 }, { tableId: 'tbl2', n: 1 }]);
  assert.equal(deps._inspect.savedMappings[2].larkTableId, 'tbl2');
  assert.equal(deps._inspect.savedMappings[2].larkRecordId, 'tbl2-rec0');
});

test('updates sync_partition boundary: first only when startIndex>0, first+last when segment starts at 0', async () => {
  const deps = makeDeps({
    chunks: [[row(1, 1), row(1, 2), row(1, 3)]],
    reserveSlotsImpl: () => [
      { partitionNo: 1, larkTableId: 'tbl1', startIndex: 49998, count: 2 }, // not partition's first write
      { partitionNo: 2, larkTableId: 'tbl2', startIndex: 0, count: 1 },     // is partition's first write
    ],
  });
  const uc = new RunFullSyncJob(deps);
  await uc.execute({ id: 1, year: 2024, attempts: 0, payload: { appId: 'a', appSecret: 's' } });

  const [b1, b2] = deps._inspect.boundaryWrites;
  assert.equal(b1.partitionNo, 1);
  assert.equal(b1.first, undefined); // startIndex was 49998, not the partition's first row
  assert.equal(b1.last.sourceKey, '114|1|2'); // last row written in this segment

  assert.equal(b2.partitionNo, 2);
  assert.equal(b2.first.sourceKey, '114|1|3'); // startIndex 0 -> this segment's first row is the partition's first
  assert.equal(b2.last.sourceKey, '114|1|3');  // and also its only (so far) last row
});

test('on error with attempts below max: reschedules via retry (not dead)', async () => {
  const deps = makeDeps({ chunks: [[row(1, 1)]] });
  deps.mappingRepository.reserveSlots = async () => { throw new Error('db down'); };
  const uc = new RunFullSyncJob(deps);
  await assert.rejects(() => uc.execute({ id: 1, year: 2024, attempts: 1, payload: { appId: 'a', appSecret: 's' } }));
  assert.equal(deps._inspect.jobQueueCalls.retry.length, 1);
  assert.equal(deps._inspect.jobQueueCalls.fail.length, 0);
});

test('self-heal: corrects fill_count down before the chunk loop when it exceeds the real Lark count', async () => {
  // Simulates resuming after a crash: reserveSlots committed fill_count for
  // a chunk whose batchCreate never actually ran, so Lark has fewer real
  // records than the partition's fill_count claims.
  const deps = makeDeps({
    chunks: [[row(1, 1)]],
    openPartition: { partitionNo: 3, larkTableId: 'tbl3', fillCount: 500 },
    countRecordsImpl: async () => 480,
  });
  const uc = new RunFullSyncJob(deps);
  await uc.execute({ id: 1, year: 2024, attempts: 0, payload: { appId: 'a', appSecret: 's' } });
  assert.deepEqual(deps._inspect.fillCountWrites, [{ year: 2024, partitionNo: 3, fillCount: 480 }]);
});

test('self-heal: does nothing when the open partition already matches the real Lark count', async () => {
  const deps = makeDeps({
    chunks: [[row(1, 1)]],
    openPartition: { partitionNo: 3, larkTableId: 'tbl3', fillCount: 500 },
    countRecordsImpl: async () => 500,
  });
  const uc = new RunFullSyncJob(deps);
  await uc.execute({ id: 1, year: 2024, attempts: 0, payload: { appId: 'a', appSecret: 's' } });
  assert.deepEqual(deps._inspect.fillCountWrites, []);
});

test('self-heal: never corrects upward, even if the real Lark count is somehow higher', async () => {
  // An excess-record case is a different problem (real orphan on Lark) for
  // check/heal to catch — RunFullSyncJob must not paper over it here.
  const deps = makeDeps({
    chunks: [[row(1, 1)]],
    openPartition: { partitionNo: 3, larkTableId: 'tbl3', fillCount: 500 },
    countRecordsImpl: async () => 600,
  });
  const uc = new RunFullSyncJob(deps);
  await uc.execute({ id: 1, year: 2024, attempts: 0, payload: { appId: 'a', appSecret: 's' } });
  assert.deepEqual(deps._inspect.fillCountWrites, []);
});

test('self-heal: skipped entirely (no countRecords call) when every partition is already full', async () => {
  // openPartition defaults to null in makeDeps, and its fake gateway.countRecords
  // throws if called — this test would fail loudly if the self-heal step
  // ever called it despite there being no open partition.
  const deps = makeDeps({ chunks: [[row(1, 1)]] });
  const uc = new RunFullSyncJob(deps);
  await uc.execute({ id: 1, year: 2024, attempts: 0, payload: { appId: 'a', appSecret: 's' } }); // does not throw
  assert.deepEqual(deps._inspect.fillCountWrites, []);
});

test('on error with attempts at max: marks the job dead and scrubs the secret', async () => {
  const deps = makeDeps({ chunks: [[row(1, 1)]] });
  deps.mappingRepository.reserveSlots = async () => { throw new Error('db down'); };
  const uc = new RunFullSyncJob(deps);
  await assert.rejects(() => uc.execute({ id: 1, year: 2024, attempts: 5, payload: { appId: 'a', appSecret: 's' } }));
  assert.equal(deps._inspect.jobQueueCalls.fail.length, 1);
  assert.deepEqual(deps._inspect.jobQueueCalls.fail[0], { id: 1, payload: { appId: 'a' } });
  assert.equal(deps._inspect.jobQueueCalls.retry.length, 0);
});
