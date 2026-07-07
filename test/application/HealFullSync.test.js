// test/application/HealFullSync.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HealFullSync } from '../../src/application/use-cases/HealFullSync.js';
import { YearNotProvisionedError } from '../../src/domain/errors.js';

function row(sellId, rowNo, crTimeBE = '2569-01-01 00:00:00') {
  return { CrTime: crTimeBE, UTime: crTimeBE, SellID: sellId, SellBranch: 114, RowNo: rowNo, Product: 'P1' };
}

function makeDeps({ partitions, mappingsByPartition, fetchBySourceKeysImpl, initialCheckpoint = null } = {}) {
  const fillCountWrites = [];
  const savedMappings = [];
  const stateWrites = [];
  return {
    sourceRepository: { async fetchBySourceKeys(q) { return fetchBySourceKeysImpl ? fetchBySourceKeysImpl(q) : []; } },
    mappingRepository: {
      async listPartitions() { return partitions; },
      async getState() { return initialCheckpoint ? { checkpoint: initialCheckpoint } : null; },
      async getMappingsForPartition({ partitionNo }) { return mappingsByPartition[partitionNo] ?? []; },
      async setFillCount(q) { fillCountWrites.push(q); },
      async saveMappings(mappings) { savedMappings.push(...mappings); },
      async setState(scope, patch) { stateWrites.push({ scope, patch }); },
    },
    yearRepository: { async getYear() { return { year: 2024, baseId: 'BASE1', status: 'complete' }; } },
    now: () => Date.parse('2026-07-07T10:00:00Z'),
    _inspect: { fillCountWrites, savedMappings, stateWrites },
  };
}

test('throws YearNotProvisionedError when the year is not provisioned', async () => {
  const deps = makeDeps({ partitions: [], mappingsByPartition: {} });
  deps.yearRepository.getYear = async () => null;
  const uc = new HealFullSync(deps);
  await assert.rejects(() => uc.execute({ gateway: {}, year: 2024, budgetMs: 1000 }), YearNotProvisionedError);
});

test('corrects fill_count drift even when the real Lark records exactly match mapping (no Lark writes)', async () => {
  const deps = makeDeps({
    partitions: [{ partitionNo: 10, larkTableId: 'tbl10', fillCount: 50000 }],
    mappingsByPartition: { 10: Array.from({ length: 3 }, (_, i) => ({ sourceKey: `k${i}`, larkRecordId: `r${i}` })) },
  });
  const gateway = { async listRecordIds() { return ['r0', 'r1', 'r2']; } }; // identical to mapping -> nothing to fix
  const uc = new HealFullSync(deps);
  const result = await uc.execute({ gateway, year: 2024, budgetMs: 1000 });
  assert.deepEqual(deps._inspect.fillCountWrites, [{ year: 2024, partitionNo: 10, fillCount: 3 }]);
  assert.deepEqual(result.actionsTaken, []); // no Lark-side action needed
});

test('catches an orphan+missing pair even when their counts cancel out (regression)', async () => {
  // Guards the bug found during live verification: countRecords-only gating
  // would see larkTotal===mappedCount here (3===3) and skip the deep-dive
  // entirely, silently leaving a stale mapping pointed at a deleted record
  // while an unrelated orphan sat untouched.
  const deps = makeDeps({
    partitions: [{ partitionNo: 10, larkTableId: 'tbl10', fillCount: 3 }],
    mappingsByPartition: { 10: [{ sourceKey: '114|0|1', larkRecordId: 'r0' }, { sourceKey: '114|1|1', larkRecordId: 'r1' }, { sourceKey: '114|2|1', larkRecordId: 'r2' }] },
    fetchBySourceKeysImpl: async () => [{ SellBranch: 114, SellID: 2, RowNo: 1, CrTime: '2569-01-01 00:00:00', UTime: '2569-01-01 00:00:00' }], // matches source_key "114|2|1"
  });
  const deletedCalls = [];
  const gateway = {
    async listRecordIds() { return ['r0', 'r1', 'orphan-x']; }, // r2 is gone, orphan-x is new — same count (3) as mapped
    async batchDelete({ recordIds }) { deletedCalls.push(recordIds); return recordIds; },
    async batchCreate({ records }) { return records.map((_r, i) => `r-new${i}`); },
  };
  const uc = new HealFullSync(deps);
  const result = await uc.execute({ gateway, year: 2024, budgetMs: 1000 });
  assert.deepEqual(deletedCalls, [['orphan-x']]);
  assert.deepEqual(result.actionsTaken, [{ partitionNo: 10, larkTableId: 'tbl10', orphansDeleted: 1, recordsRecreated: 1 }]);
});

test('deletes orphan records not referenced by any mapping', async () => {
  const deps = makeDeps({
    partitions: [{ partitionNo: 10, larkTableId: 'tbl10', fillCount: 2 }],
    mappingsByPartition: { 10: [{ sourceKey: 'k0', larkRecordId: 'r0' }, { sourceKey: 'k1', larkRecordId: 'r1' }] },
  });
  const deletedCalls = [];
  const gateway = {
    async listRecordIds() { return ['r0', 'r1', 'orphan1', 'orphan2']; },
    async batchDelete({ recordIds }) { deletedCalls.push(recordIds); return recordIds.map((id) => id); },
  };
  const uc = new HealFullSync(deps);
  const result = await uc.execute({ gateway, year: 2024, budgetMs: 1000 });
  assert.deepEqual(deletedCalls, [['orphan1', 'orphan2']]);
  assert.deepEqual(result.actionsTaken, [{ partitionNo: 10, larkTableId: 'tbl10', orphansDeleted: 2, recordsRecreated: 0 }]);
});

test('recreates a missing record by re-fetching the source row and re-mapping it', async () => {
  const lostRow = row(1, 1);
  const deps = makeDeps({
    partitions: [{ partitionNo: 10, larkTableId: 'tbl10', fillCount: 1 }],
    mappingsByPartition: { 10: [{ sourceKey: '114|1|1', larkRecordId: 'r-lost' }] },
    fetchBySourceKeysImpl: async ({ sourceKeys }) => (sourceKeys.includes('114|1|1') ? [lostRow] : []),
  });
  const gateway = {
    async listRecordIds() { return []; },
    async batchDelete() { return []; },
    async batchCreate({ records }) { return records.map((_r, i) => `r-new${i}`); },
  };
  const uc = new HealFullSync(deps);
  const result = await uc.execute({ gateway, year: 2024, budgetMs: 1000 });
  assert.equal(deps._inspect.savedMappings.length, 1);
  assert.equal(deps._inspect.savedMappings[0].sourceKey, '114|1|1');
  assert.equal(deps._inspect.savedMappings[0].larkRecordId, 'r-new0');
  assert.deepEqual(result.actionsTaken, [{ partitionNo: 10, larkTableId: 'tbl10', orphansDeleted: 0, recordsRecreated: 1 }]);
});

test('silently skips a missing mapping whose source row no longer exists in Com7', async () => {
  const deps = makeDeps({
    partitions: [{ partitionNo: 10, larkTableId: 'tbl10', fillCount: 1 }],
    mappingsByPartition: { 10: [{ sourceKey: '114|1|1', larkRecordId: 'r-lost' }] },
    fetchBySourceKeysImpl: async () => [], // physically deleted at the source
  });
  const gateway = {
    async listRecordIds() { return []; },
    async batchDelete() { return []; },
    async batchCreate() { throw new Error('should not be called — nothing to recreate from'); },
  };
  const uc = new HealFullSync(deps);
  const result = await uc.execute({ gateway, year: 2024, budgetMs: 1000 });
  assert.equal(deps._inspect.savedMappings.length, 0);
  assert.deepEqual(result.actionsTaken, []);
});

test('respects the budget and resumes from a persisted checkpoint', async () => {
  const partitions = [
    { partitionNo: 1, larkTableId: 'tbl1', fillCount: 1 },
    { partitionNo: 2, larkTableId: 'tbl2', fillCount: 1 },
  ];
  const deps = makeDeps({
    partitions,
    mappingsByPartition: { 1: [{ sourceKey: 'a', larkRecordId: 'ra' }], 2: [{ sourceKey: 'b', larkRecordId: 'rb' }] },
  });
  let calls = 0;
  deps.now = () => { calls++; return calls <= 2 ? 0 : 999999; };
  const gateway = { async listRecordIds() { return ['ra']; } };
  const uc = new HealFullSync(deps);
  const result = await uc.execute({ gateway, year: 2024, budgetMs: 1000 });
  assert.equal(result.done, false);
  assert.equal(result.partitionsProcessed, 1);

  // Resume: second call should pick up from partition 2 only.
  const seenTableIds = [];
  const deps2 = makeDeps({
    partitions,
    mappingsByPartition: { 1: [{ sourceKey: 'a', larkRecordId: 'ra' }], 2: [{ sourceKey: 'b', larkRecordId: 'rb' }] },
    initialCheckpoint: deps._inspect.stateWrites.at(-1).patch.checkpoint,
  });
  const gateway2 = { async listRecordIds({ tableId }) { seenTableIds.push(tableId); return tableId === 'tbl2' ? ['rb'] : ['ra']; } };
  const uc2 = new HealFullSync(deps2);
  const result2 = await uc2.execute({ gateway: gateway2, year: 2024, budgetMs: 1000 });
  assert.deepEqual(seenTableIds, ['tbl2']);
  assert.equal(result2.done, true);
});

test('a fresh call after a prior heal already finished re-scans from scratch, not a no-op', async () => {
  // Regression: same bug class as CheckFullSync — a checkpoint whose cursor
  // already reached the last partition must not be mistaken for "nothing
  // left to heal" on a later, independent invocation.
  const deps = makeDeps({
    partitions: [{ partitionNo: 1, larkTableId: 'tbl1', fillCount: 2 }],
    mappingsByPartition: { 1: [{ sourceKey: 'k0', larkRecordId: 'r0' }, { sourceKey: 'k1', larkRecordId: 'r1' }] },
    // A previous heal already completed and found nothing to do.
    initialCheckpoint: { lastPartitionNo: 1, actionsTaken: [] },
  });
  const deletedCalls = [];
  const gateway = {
    async listRecordIds() { return ['r0', 'r1', 'orphan-new']; },
    async batchDelete({ recordIds }) { deletedCalls.push(recordIds); return recordIds; },
  };
  const uc = new HealFullSync(deps);
  const result = await uc.execute({ gateway, year: 2024, budgetMs: 1000 });
  assert.deepEqual(deletedCalls, [['orphan-new']]);
  assert.deepEqual(result.actionsTaken, [{ partitionNo: 1, larkTableId: 'tbl1', orphansDeleted: 1, recordsRecreated: 0 }]);
});
