import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemoveAllPartitions } from '../../src/application/use-cases/RemoveAllPartitions.js';
import { parsePartitionNo } from '../../src/domain/services/partition.js';

const mk = (opts) => new RemoveAllPartitions({ parsePartitionNo, now: opts.now });

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
  const r = await mk({ now: () => 0 }).execute({ gateway: gw, base: 'B', year: 2023, budgetMs: 10000 });
  assert.deepEqual(gw.deleted.sort(), ['itec_001', 'itec_002']);
  assert.deepEqual(r, { year: 2023, base: 'B', total: 2, deleted: 2, remaining: 0, done: true });
});

test('idempotent: no partitions left deletes nothing', async () => {
  const gw = fakeGateway(['Table']);
  const r = await mk({ now: () => 0 }).execute({ gateway: gw, base: 'B', year: 2023, budgetMs: 10000 });
  assert.equal(gw.deleted.length, 0);
  assert.deepEqual(r, { year: 2023, base: 'B', total: 0, deleted: 0, remaining: 0, done: true });
});

test('guard stops early and reports remaining', async () => {
  const gw = fakeGateway(['itec_001', 'itec_002', 'itec_003']);
  let t = 0; // each now() advances 6s; budget 10s allows ~1 delete
  const r = await mk({ now: () => (t += 6000) - 6000 }).execute({ gateway: gw, base: 'B', year: 2023, budgetMs: 10000 });
  assert.equal(r.done, false);
  assert.ok(r.remaining > 0);
  assert.equal(r.deleted + r.remaining, r.total);
});
