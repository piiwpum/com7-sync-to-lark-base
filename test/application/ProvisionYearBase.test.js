import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProvisionYearBase } from '../../src/application/use-cases/ProvisionYearBase.js';
import { partitionName, parsePartitionNo } from '../../src/domain/services/partition.js';

// 3 partitions total, minimal schema
const mk = (opts) => new ProvisionYearBase({
  fieldSchema: [{ type: 'text', name: 'A' }, { type: 'text', name: 'B' }],
  partitionCount: 3, partitionName, parsePartitionNo, now: opts.now,
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
  const r = await mk({ now: () => 0 }).execute({ gateway: gw, base: 'B', year: 2024, budgetMs: 10000 });
  assert.deepEqual(gw.created, ['itec_001', 'itec_002', 'itec_003']);
  assert.deepEqual(r, { year: 2024, base: 'B', total: 3, existing: 0, created: 3, remaining: 0, done: true });
});

test('idempotent: complete base creates nothing', async () => {
  const gw = fakeGateway(['itec_001', 'itec_002', 'itec_003']);
  const r = await mk({ now: () => 0 }).execute({ gateway: gw, base: 'B', year: 2024, budgetMs: 10000 });
  assert.equal(gw.created.length, 0);
  assert.equal(r.existing, 3);
  assert.equal(r.created, 0);
  assert.equal(r.done, true);
});

test('resume: creates only the missing partitions (ignores non-itec tables)', async () => {
  const gw = fakeGateway(['itec_001', 'Table', 'daily_01']);
  const r = await mk({ now: () => 0 }).execute({ gateway: gw, base: 'B', year: 2024, budgetMs: 10000 });
  assert.deepEqual(gw.created, ['itec_002', 'itec_003']);
  assert.equal(r.existing, 1);
  assert.equal(r.created, 2);
  assert.equal(r.done, true);
});

test('guard stops early and reports remaining', async () => {
  const gw = fakeGateway();
  let t = 0; // each now() advances 6s; budget 10s allows ~1 create
  const r = await mk({ now: () => (t += 6000) - 6000 }).execute({ gateway: gw, base: 'B', year: 2024, budgetMs: 10000 });
  assert.equal(r.done, false);
  assert.ok(r.remaining > 0);
});
