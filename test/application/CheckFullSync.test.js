// test/application/CheckFullSync.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckFullSync } from '../../src/application/use-cases/CheckFullSync.js';
import { YearNotProvisionedError } from '../../src/domain/errors.js';

function makeDeps({ partitions, mappingsByPartition, larkTotals, com7Count = 0, initialCheckpoint = null }) {
  const stateWrites = [];
  return {
    sourceRepository: { async countItec() { return com7Count; } },
    mappingRepository: {
      async listPartitions() { return partitions; },
      async getState() { return initialCheckpoint ? { checkpoint: initialCheckpoint } : null; },
      async getMappingsForPartition({ partitionNo }) { return mappingsByPartition[partitionNo] ?? []; },
      async setState(scope, patch) { stateWrites.push({ scope, patch }); },
    },
    yearRepository: { async getYear() { return { year: 2024, baseId: 'BASE1', status: 'complete' }; } },
    now: () => Date.parse('2026-07-07T10:00:00Z'),
    _inspect: { stateWrites },
  };
}

function gatewayWith(larkTotals) {
  return { async countRecords({ tableId }) { return larkTotals[tableId]; } };
}

test('throws YearNotProvisionedError when the year is not provisioned', async () => {
  const deps = makeDeps({ partitions: [], mappingsByPartition: {}, larkTotals: {} });
  deps.yearRepository.getYear = async () => null;
  const uc = new CheckFullSync(deps);
  await assert.rejects(() => uc.execute({ gateway: gatewayWith({}), year: 2024, budgetMs: 1000 }), YearNotProvisionedError);
});

test('reports ok when fillCount, mappedCount, and larkTotal all agree', async () => {
  const deps = makeDeps({
    partitions: [{ partitionNo: 1, larkTableId: 'tbl1', fillCount: 2 }],
    mappingsByPartition: { 1: [{ sourceKey: 'a' }, { sourceKey: 'b' }] },
  });
  const uc = new CheckFullSync(deps);
  const result = await uc.execute({ gateway: gatewayWith({ tbl1: 2 }), year: 2024, budgetMs: 1000 });
  assert.equal(result.done, true);
  assert.deepEqual(result.findings, []);
});

test('flags fill_count_drift when larkTotal matches mapped but fillCount does not', async () => {
  const deps = makeDeps({
    partitions: [{ partitionNo: 10, larkTableId: 'tbl10', fillCount: 50000 }],
    mappingsByPartition: { 10: Array.from({ length: 49800 }, (_, i) => ({ sourceKey: `k${i}` })) },
  });
  const uc = new CheckFullSync(deps);
  const result = await uc.execute({ gateway: gatewayWith({ tbl10: 49800 }), year: 2024, budgetMs: 1000 });
  assert.deepEqual(result.findings, [
    { partitionNo: 10, larkTableId: 'tbl10', mappedCount: 49800, fillCount: 50000, larkTotal: 49800, status: 'fill_count_drift' },
  ]);
});

test('flags lark_drift when larkTotal disagrees with mappedCount (takes priority over fill_count_drift)', async () => {
  const deps = makeDeps({
    partitions: [{ partitionNo: 10, larkTableId: 'tbl10', fillCount: 50000 }],
    mappingsByPartition: { 10: Array.from({ length: 49800 }, (_, i) => ({ sourceKey: `k${i}` })) },
  });
  const uc = new CheckFullSync(deps);
  const result = await uc.execute({ gateway: gatewayWith({ tbl10: 50200 }), year: 2024, budgetMs: 1000 });
  assert.deepEqual(result.findings, [
    { partitionNo: 10, larkTableId: 'tbl10', mappedCount: 49800, fillCount: 50000, larkTotal: 50200, status: 'lark_drift' },
  ]);
});

test('year-level summary only appears when done, and flags backfillIncomplete', async () => {
  const deps = makeDeps({
    partitions: [{ partitionNo: 1, larkTableId: 'tbl1', fillCount: 100 }],
    mappingsByPartition: { 1: Array.from({ length: 100 }, (_, i) => ({ sourceKey: `k${i}` })) },
    com7Count: 500, // more than mapped -> backfill incomplete
  });
  const uc = new CheckFullSync(deps);
  const result = await uc.execute({ gateway: gatewayWith({ tbl1: 100 }), year: 2024, budgetMs: 1000 });
  assert.equal(result.done, true);
  assert.deepEqual(result.summary, { com7Count: 500, mappedTotal: 100, larkGrandTotal: 100, backfillIncomplete: true });
});

test('respects the budget and returns done:false partway through, persisting a resumable checkpoint', async () => {
  const partitions = [
    { partitionNo: 1, larkTableId: 'tbl1', fillCount: 1 },
    { partitionNo: 2, larkTableId: 'tbl2', fillCount: 1 },
  ];
  const deps = makeDeps({
    partitions,
    mappingsByPartition: { 1: [{ sourceKey: 'a' }], 2: [{ sourceKey: 'b' }] },
  });
  let calls = 0;
  deps.now = () => { calls++; return calls <= 2 ? 0 : 999999; }; // call 1 = start, call 2 = partition-1 budget check (ok), call 3+ = exhausted
  const uc = new CheckFullSync(deps);
  const result = await uc.execute({ gateway: gatewayWith({ tbl1: 1, tbl2: 1 }), year: 2024, budgetMs: 1000 });
  assert.equal(result.done, false);
  assert.equal(result.partitionsChecked, 1);
  assert.equal(result.summary, undefined);
  const persisted = deps._inspect.stateWrites.at(-1).patch.checkpoint;
  assert.equal(persisted.lastPartitionNo, 1);
});

test('resumes from a persisted checkpoint instead of starting over', async () => {
  const partitions = [
    { partitionNo: 1, larkTableId: 'tbl1', fillCount: 1 },
    { partitionNo: 2, larkTableId: 'tbl2', fillCount: 1 },
  ];
  const deps = makeDeps({
    partitions,
    mappingsByPartition: { 1: [{ sourceKey: 'a' }], 2: [{ sourceKey: 'b' }] },
    initialCheckpoint: { lastPartitionNo: 1, findings: [], mappedTotal: 1, larkGrandTotal: 1 },
  });
  let seenTableIds = [];
  const gateway = { async countRecords({ tableId }) { seenTableIds.push(tableId); return 1; } };
  const uc = new CheckFullSync(deps);
  const result = await uc.execute({ gateway, year: 2024, budgetMs: 1000 });
  assert.deepEqual(seenTableIds, ['tbl2']); // partition 1 already checked, not re-fetched
  assert.equal(result.done, true);
  assert.equal(result.summary.mappedTotal, 2);
});

test('a fresh call after a prior scan already finished re-scans from scratch, not stale cached findings', async () => {
  // Regression: a checkpoint whose cursor already reached the last partition
  // must not be treated as "nothing left to do" — otherwise a second call
  // for the same year (made specifically to catch NEW drift) would silently
  // return the first call's now-stale findings forever.
  const deps = makeDeps({
    partitions: [{ partitionNo: 1, larkTableId: 'tbl1', fillCount: 5 }],
    mappingsByPartition: { 1: Array.from({ length: 5 }, (_, i) => ({ sourceKey: `k${i}` })) },
    // A previous scan already completed and found nothing wrong.
    initialCheckpoint: { lastPartitionNo: 1, findings: [], mappedTotal: 5, larkGrandTotal: 5 },
  });
  const uc = new CheckFullSync(deps);
  // New drift has appeared since: Lark now has 6 real records for 5 mapped.
  const result = await uc.execute({ gateway: gatewayWith({ tbl1: 6 }), year: 2024, budgetMs: 1000 });
  assert.equal(result.done, true);
  assert.deepEqual(result.findings, [
    { partitionNo: 1, larkTableId: 'tbl1', mappedCount: 5, fillCount: 5, larkTotal: 6, status: 'lark_drift' },
  ]);
});
