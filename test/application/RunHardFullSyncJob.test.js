import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunHardFullSyncJob } from '../../src/application/use-cases/RunHardFullSyncJob.js';

function makeDeps({
  partitions = [{ partitionNo: 1, larkTableId: 'tbl1', fillCount: 2 }],
  mappedByPartition = {}, // partitionNo -> [{sourceKey, larkRecordId}]
  larkByTable = {},       // tableId -> [recordId] currently on Lark (orphan sweep)
  state = null,
  deleteChunkSize = 500,
} = {}) {
  const calls = {
    batchDelete: [], listRecordIds: [], setState: [], clearState: [],
    clearYearMappings: [], resetPartitions: [], enqueueFull: [],
    complete: [], fail: [], retry: [],
  };
  const gateway = {
    async listRecordIds({ tableId }) { calls.listRecordIds.push(tableId); return larkByTable[tableId] ?? []; },
    async batchDelete({ tableId, recordIds }) { calls.batchDelete.push({ tableId, recordIds }); return recordIds; },
  };
  const deps = {
    yearRepository: { async getYear() { return { year: 2026, baseId: 'BASE', status: 'complete' }; } },
    mappingRepository: {
      async getState() { return state; },
      async setState(scope, patch) { calls.setState.push({ scope, patch }); },
      async clearState(q) { calls.clearState.push(q); },
      async listPartitions() { return partitions; },
      async getMappingsForPartition({ partitionNo }) { return mappedByPartition[partitionNo] ?? []; },
      async clearYearMappings(q) { calls.clearYearMappings.push(q); },
      async resetPartitionsForYear(q) { calls.resetPartitions.push(q); },
    },
    enqueueFullSync: { async execute(q) { calls.enqueueFull.push(q); return { year: q.year, jobId: 99, status: 'ready' }; } },
    jobQueue: {
      async complete(q) { calls.complete.push(q); },
      async fail(q) { calls.fail.push(q); },
      async retry(q) { calls.retry.push(q); },
    },
    tokenCache: { async getToken() { return 'tok'; } },
    createGateway: () => gateway,
    baseDomain: 'https://x',
    deleteChunkSize,
    now: () => 1_000_000,
  };
  return { deps, calls, gateway };
}

const job = (over = {}) => ({ id: 7, year: 2026, attempts: 0, payload: { appId: 'a', appSecret: 's' }, ...over });

test('clears each partition (mapped ids then orphan sweep), then wipes ops and hands off to full_sync', async () => {
  const { deps, calls } = makeDeps({
    partitions: [{ partitionNo: 1, larkTableId: 'tbl1', fillCount: 2 }],
    mappedByPartition: { 1: [{ sourceKey: 'k1', larkRecordId: 'r1' }, { sourceKey: 'k2', larkRecordId: 'r2' }] },
    larkByTable: { tbl1: ['orphanX'] }, // one record not in mapping -> swept
  });
  const uc = new RunHardFullSyncJob(deps);
  await uc.execute(job());

  // (a) mapped delete, then (b) orphan sweep — both against tbl1
  assert.deepEqual(calls.batchDelete[0], { tableId: 'tbl1', recordIds: ['r1', 'r2'] });
  assert.deepEqual(calls.listRecordIds, ['tbl1']);
  assert.deepEqual(calls.batchDelete[1], { tableId: 'tbl1', recordIds: ['orphanX'] });
  // checkpoint after the partition
  assert.deepEqual(calls.setState.find((s) => s.scope === 'hard_full:2026').patch.checkpoint, 1);
  // ops wipe
  assert.deepEqual(calls.clearYearMappings[0], { year: 2026 });
  assert.deepEqual(calls.resetPartitions[0], { year: 2026 });
  assert.ok(calls.clearState.some((c) => c.scope === 'full_sync:2026')); // fresh backfill
  // hand off to backfill + complete (secret scrubbed)
  assert.deepEqual(calls.enqueueFull[0], { year: 2026, appId: 'a', appSecret: 's' });
  assert.deepEqual(calls.complete[0], { id: 7, payload: { appId: 'a' } });
});

test('resumes from checkpoint — already-cleared partitions are skipped', async () => {
  const { deps, calls } = makeDeps({
    partitions: [
      { partitionNo: 1, larkTableId: 'tbl1', fillCount: 0 },
      { partitionNo: 2, larkTableId: 'tbl2', fillCount: 3 },
    ],
    mappedByPartition: { 2: [{ sourceKey: 'k', larkRecordId: 'r' }] },
    larkByTable: { tbl2: [] },
    state: { checkpoint: 1 }, // partition 1 already done
  });
  const uc = new RunHardFullSyncJob(deps);
  await uc.execute(job());
  assert.deepEqual(calls.listRecordIds, ['tbl2']); // only partition 2 touched
  assert.ok(calls.batchDelete.every((b) => b.tableId === 'tbl2'));
});

test('batchDelete is chunked to deleteChunkSize', async () => {
  const ids = Array.from({ length: 1200 }, (_, i) => `r${i}`);
  const { deps, calls } = makeDeps({
    partitions: [{ partitionNo: 1, larkTableId: 'tbl1', fillCount: 1200 }],
    mappedByPartition: { 1: ids.map((id) => ({ sourceKey: id, larkRecordId: id })) },
    deleteChunkSize: 500,
  });
  const uc = new RunHardFullSyncJob(deps);
  await uc.execute(job());
  const mappedDeletes = calls.batchDelete.filter((b) => b.recordIds.length > 0);
  assert.deepEqual(mappedDeletes.map((b) => b.recordIds.length), [500, 500, 200]);
});

test('a partition with nothing to delete still sweeps and checkpoints, no empty batchDelete', async () => {
  const { deps, calls } = makeDeps({
    partitions: [{ partitionNo: 1, larkTableId: 'tbl1', fillCount: 0 }],
    mappedByPartition: { 1: [] },
    larkByTable: { tbl1: [] },
  });
  const uc = new RunHardFullSyncJob(deps);
  await uc.execute(job());
  assert.equal(calls.batchDelete.length, 0); // never call batchDelete with an empty list
  assert.equal(calls.enqueueFull.length, 1);
});

test('retries with backoff below maxAttempts and scrubs the secret', async () => {
  const { deps, calls } = makeDeps();
  deps.mappingRepository.listPartitions = async () => { throw new Error('boom'); };
  const uc = new RunHardFullSyncJob(deps);
  await assert.rejects(() => uc.execute(job({ attempts: 1 })));
  assert.equal(calls.retry.length, 1);
  assert.equal(calls.fail.length, 0);
});

test('marks the job dead at maxAttempts', async () => {
  const { deps, calls } = makeDeps();
  deps.mappingRepository.listPartitions = async () => { throw new Error('boom'); };
  const uc = new RunHardFullSyncJob(deps);
  await assert.rejects(() => uc.execute(job({ attempts: 5 })));
  assert.equal(calls.fail.length, 1);
  assert.deepEqual(calls.fail[0], { id: 7, payload: { appId: 'a' } });
});
