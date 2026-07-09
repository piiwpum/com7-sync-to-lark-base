import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemoveAllPartitions } from '../../src/application/use-cases/RemoveAllPartitions.js';
import { parsePartitionNo } from '../../src/domain/services/partition.js';

function fakeYearRepository() {
  return {
    deletePartitionsCalls: [],
    async deletePartitions(year, partitionNos) { this.deletePartitionsCalls.push({ year, partitionNos }); },
  };
}

function fakeMappingRepository() {
  return {
    deleteMappingsCalls: [],
    async deleteMappingsForPartitions({ year, partitionNos }) { this.deleteMappingsCalls.push({ year, partitionNos }); },
  };
}

const mk = (opts) => new RemoveAllPartitions({
  parsePartitionNo,
  yearRepository: opts.yearRepository,
  mappingRepository: opts.mappingRepository ?? fakeMappingRepository(),
  now: opts.now,
});

function fakeGateway(initialTableNames = []) {
  const names = new Set(initialTableNames);
  return {
    deleted: [],
    async getBase() {},
    async listTables() { return [...names].map((name) => ({ name, tableId: name })); },
    async deleteTable(_b, tableId) { names.delete(tableId); this.deleted.push(tableId); },
  };
}

test('deletes all itec_* partition tables, ignores other tables', async () => {
  const gw = fakeGateway(['itec_001', 'itec_002', 'Table', 'daily_01']);
  const yr = fakeYearRepository();
  const r = await mk({ now: () => 0, yearRepository: yr }).execute({ gateway: gw, base: 'B', year: 2023, budgetMs: 10000 });
  assert.deepEqual(gw.deleted.sort(), ['itec_001', 'itec_002']);
  assert.deepEqual(r, { year: 2023, base: 'B', total: 2, deleted: 2, remaining: 0, done: true });
});

test('idempotent: no partitions left deletes nothing', async () => {
  const gw = fakeGateway(['Table']);
  const yr = fakeYearRepository();
  const r = await mk({ now: () => 0, yearRepository: yr }).execute({ gateway: gw, base: 'B', year: 2023, budgetMs: 10000 });
  assert.equal(gw.deleted.length, 0);
  assert.deepEqual(r, { year: 2023, base: 'B', total: 0, deleted: 0, remaining: 0, done: true });
});

test('guard stops early and reports remaining', async () => {
  const gw = fakeGateway(['itec_001', 'itec_002', 'itec_003']);
  const yr = fakeYearRepository();
  let t = 0; // each now() advances 6s; budget 10s allows ~1 delete
  const r = await mk({ now: () => (t += 6000) - 6000, yearRepository: yr })
    .execute({ gateway: gw, base: 'B', year: 2023, budgetMs: 10000 });
  assert.equal(r.done, false);
  assert.ok(r.remaining > 0);
  assert.equal(r.deleted + r.remaining, r.total);
});

test('deletePartitions called with the partition numbers actually deleted', async () => {
  const gw = fakeGateway(['itec_001', 'itec_002']);
  const yr = fakeYearRepository();
  await mk({ now: () => 0, yearRepository: yr }).execute({ gateway: gw, base: 'B', year: 2023, budgetMs: 10000 });
  assert.equal(yr.deletePartitionsCalls.length, 1);
  assert.equal(yr.deletePartitionsCalls[0].year, 2023);
  assert.deepEqual(yr.deletePartitionsCalls[0].partitionNos.sort(), [1, 2]);
});

test('deleteMappingsForPartitions called with the partition numbers actually deleted', async () => {
  const gw = fakeGateway(['itec_001', 'itec_002']);
  const yr = fakeYearRepository();
  const mr = fakeMappingRepository();
  await mk({ now: () => 0, yearRepository: yr, mappingRepository: mr })
    .execute({ gateway: gw, base: 'B', year: 2023, budgetMs: 10000 });
  assert.equal(mr.deleteMappingsCalls.length, 1);
  assert.equal(mr.deleteMappingsCalls[0].year, 2023);
  assert.deepEqual(mr.deleteMappingsCalls[0].partitionNos.sort(), [1, 2]);
});

test('partial run clears mappings only for partitions actually dropped', async () => {
  const gw = fakeGateway(['itec_001', 'itec_002', 'itec_003']);
  const yr = fakeYearRepository();
  const mr = fakeMappingRepository();
  let t = 0; // each now() advances 6s; budget 10s allows ~1 delete
  await mk({ now: () => (t += 6000) - 6000, yearRepository: yr, mappingRepository: mr })
    .execute({ gateway: gw, base: 'B', year: 2023, budgetMs: 10000 });
  // mapping + partition cleanup target the same set: exactly what was deleted on Lark
  assert.deepEqual(mr.deleteMappingsCalls[0].partitionNos.sort(), yr.deletePartitionsCalls[0].partitionNos.sort());
  assert.deepEqual(mr.deleteMappingsCalls[0].partitionNos.sort(), gw.deleted.map(parsePartitionNo).sort());
});

test('dryRun: reports what would be deleted, deletes nothing on Lark or MySQL', async () => {
  const gw = fakeGateway(['itec_001', 'itec_002', 'Table']);
  const yr = fakeYearRepository();
  const mr = fakeMappingRepository();
  const r = await mk({ now: () => 0, yearRepository: yr, mappingRepository: mr })
    .execute({ gateway: gw, base: 'B', year: 2023, budgetMs: 10000, dryRun: true });
  assert.equal(gw.deleted.length, 0);
  assert.equal(yr.deletePartitionsCalls.length, 0);
  assert.equal(mr.deleteMappingsCalls.length, 0);
  assert.equal(r.dryRun, true);
  assert.equal(r.total, 2);
  assert.deepEqual(r.tables.sort(), ['itec_001', 'itec_002']);
});
