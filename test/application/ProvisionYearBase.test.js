import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProvisionYearBase } from '../../src/application/use-cases/ProvisionYearBase.js';
import { partitionName, parsePartitionNo } from '../../src/domain/services/partition.js';

// 3 partitions total, schema of 2 fields
const mk = (opts) => new ProvisionYearBase({
  fieldSchema: [{ type: 'text', name: 'A' }, { type: 'text', name: 'B' }],
  fieldNames: ['A', 'B'], partitionCount: 3, partitionName, parsePartitionNo,
  now: opts.now,
});

function fakeGateway(initialTables = []) {
  const tables = new Map(initialTables.map((t) => [t.name, { tableId: t.name, fields: t.fields ?? ['A', 'B'] }]));
  return {
    created: [], fieldsAdded: [],
    async getBase() {},
    async listTables() { return [...tables].map(([name, v]) => ({ name, tableId: v.tableId })); },
    async createTable(_b, name, fields) {
      tables.set(name, { tableId: name, fields: fields.map((f) => f.name) });
      this.created.push(name); return name;
    },
    async listFields(_b, tid) { return [...tables.values()].find((v) => v.tableId === tid).fields; },
    async createField(_b, tid, f) {
      [...tables.values()].find((v) => v.tableId === tid).fields.push(f.name);
      this.fieldsAdded.push([tid, f.name]);
    },
  };
}

test('creates all missing partitions on an empty base', async () => {
  const gw = fakeGateway();
  const r = await mk({ now: () => 0 }).execute({ gateway: gw, base: 'B', year: 2024, budgetMs: 10000 });
  assert.deepEqual(gw.created, ['itec_001', 'itec_002', 'itec_003']);
  assert.deepEqual(r, { year: 2024, base: 'B', total: 3, existing: 0, created: 3, remaining: 0, done: true });
});

test('idempotent: complete base creates nothing', async () => {
  const gw = fakeGateway([{ name: 'itec_001' }, { name: 'itec_002' }, { name: 'itec_003' }]);
  const r = await mk({ now: () => 0 }).execute({ gateway: gw, base: 'B', year: 2024, budgetMs: 10000 });
  assert.equal(gw.created.length, 0);
  assert.equal(r.created, 0);
  assert.equal(r.done, true);
});

test('backfills missing fields on a partial table', async () => {
  const gw = fakeGateway([{ name: 'itec_001', fields: ['A'] }, { name: 'itec_002' }, { name: 'itec_003' }]);
  await mk({ now: () => 0 }).execute({ gateway: gw, base: 'B', year: 2024, budgetMs: 10000 });
  assert.deepEqual(gw.fieldsAdded, [['itec_001', 'B']]);
});

test('guard stops early and reports remaining', async () => {
  const gw = fakeGateway();
  let t = 0; // each now() advances 6s; budget 10s allows ~1 create
  const r = await mk({ now: () => (t += 6000) - 6000 }).execute({ gateway: gw, base: 'B', year: 2024, budgetMs: 10000 });
  assert.equal(r.done, false);
  assert.ok(r.remaining > 0);
});
