import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProvisionYearBase } from '../../src/application/use-cases/ProvisionYearBase.js';
import { partitionName, parsePartitionNo } from '../../src/domain/services/partition.js';

function fakeYearRepository() {
  return {
    upsertYearCalls: [], upsertPartitionsCalls: [],
    async upsertYear(q) { this.upsertYearCalls.push(q); },
    async upsertPartitions(year, partitions) { this.upsertPartitionsCalls.push({ year, partitions }); },
  };
}

// 3 partitions total, minimal schema
const mk = (opts) => new ProvisionYearBase({
  fieldSchema: [{ type: 'text', name: 'A' }, { type: 'text', name: 'B' }],
  partitionCount: 3, partitionName, parsePartitionNo,
  yearRepository: opts.yearRepository, now: opts.now,
});

function fakeGateway(initialTableNames = []) {
  const names = new Set(initialTableNames);
  return {
    created: [],
    async getBase() {},
    async listTables() { return [...names].map((name) => ({ name, tableId: name })); },
    async createTable(_b, name) { names.add(name); this.created.push(name); return name; },
  };
}

test('creates all missing partitions on an empty base', async () => {
  const gw = fakeGateway();
  const yr = fakeYearRepository();
  const r = await mk({ now: () => 0, yearRepository: yr }).execute({ gateway: gw, base: 'B', year: 2024, budgetMs: 10000 });
  assert.deepEqual(gw.created, ['itec_001', 'itec_002', 'itec_003']);
  assert.deepEqual(r, { year: 2024, base: 'B', total: 3, existing: 0, created: 3, remaining: 0, done: true });
});

test('idempotent: complete base creates nothing', async () => {
  const gw = fakeGateway(['itec_001', 'itec_002', 'itec_003']);
  const yr = fakeYearRepository();
  const r = await mk({ now: () => 0, yearRepository: yr }).execute({ gateway: gw, base: 'B', year: 2024, budgetMs: 10000 });
  assert.equal(gw.created.length, 0);
  assert.equal(r.existing, 3);
  assert.equal(r.created, 0);
  assert.equal(r.done, true);
});

test('resume: creates only the missing partitions (ignores non-itec tables)', async () => {
  const gw = fakeGateway(['itec_001', 'Table', 'daily_01']);
  const yr = fakeYearRepository();
  const r = await mk({ now: () => 0, yearRepository: yr }).execute({ gateway: gw, base: 'B', year: 2024, budgetMs: 10000 });
  assert.deepEqual(gw.created, ['itec_002', 'itec_003']);
  assert.equal(r.existing, 1);
  assert.equal(r.created, 2);
  assert.equal(r.done, true);
});

test('guard stops early and reports remaining', async () => {
  const gw = fakeGateway();
  const yr = fakeYearRepository();
  let t = 0; // each now() advances 6s; budget 10s allows ~1 create
  const r = await mk({ now: () => (t += 6000) - 6000, yearRepository: yr })
    .execute({ gateway: gw, base: 'B', year: 2024, budgetMs: 10000 });
  assert.equal(r.done, false);
  assert.ok(r.remaining > 0);
});

test('writes every present partition (new + pre-existing) to yearRepository', async () => {
  const gw = fakeGateway(['itec_001']); // itec_002, itec_003 will be created
  const yr = fakeYearRepository();
  await mk({ now: () => 0, yearRepository: yr }).execute({ gateway: gw, base: 'B', year: 2024, budgetMs: 10000 });
  assert.equal(yr.upsertPartitionsCalls.length, 1);
  assert.equal(yr.upsertPartitionsCalls[0].year, 2024);
  const byNo = Object.fromEntries(yr.upsertPartitionsCalls[0].partitions.map((p) => [p.partitionNo, p.larkTableId]));
  assert.deepEqual(byNo, { 1: 'itec_001', 2: 'itec_002', 3: 'itec_003' });
});

test('upserts sync_year with status=complete when done', async () => {
  const gw = fakeGateway();
  const yr = fakeYearRepository();
  await mk({ now: () => 0, yearRepository: yr }).execute({ gateway: gw, base: 'B', year: 2024, budgetMs: 10000 });
  assert.deepEqual(yr.upsertYearCalls, [{ year: 2024, baseId: 'B', status: 'complete' }]);
});

test('does not write through stray itec_NNN tables outside 1..partitionCount', async () => {
  // itec_099 matches the naming pattern but is outside this base's configured
  // partitionCount:3 — e.g. leftover from a differently-scoped run. It must
  // not be recorded into sync_partition under this call's year.
  const gw = fakeGateway(['itec_001', 'itec_002', 'itec_003', 'itec_099']);
  const yr = fakeYearRepository();
  await mk({ now: () => 0, yearRepository: yr }).execute({ gateway: gw, base: 'B', year: 2024, budgetMs: 10000 });
  const nos = yr.upsertPartitionsCalls[0].partitions.map((p) => p.partitionNo).sort((a, b) => a - b);
  assert.deepEqual(nos, [1, 2, 3]);
});

test('upserts sync_year with status=partial when guard stops early', async () => {
  const gw = fakeGateway();
  const yr = fakeYearRepository();
  let t = 0;
  await mk({ now: () => (t += 6000) - 6000, yearRepository: yr })
    .execute({ gateway: gw, base: 'B', year: 2024, budgetMs: 10000 });
  assert.deepEqual(yr.upsertYearCalls, [{ year: 2024, baseId: 'B', status: 'partial' }]);
});
