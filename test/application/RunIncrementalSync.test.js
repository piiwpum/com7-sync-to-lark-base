import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunIncrementalSync } from '../../src/application/use-cases/RunIncrementalSync.js';
import { crc32 } from '../../src/domain/services/checksum.js';
import { transformItecRow } from '../../src/domain/services/transformItecRow.js';
import { YearsNotProvisionedError } from '../../src/domain/errors.js';

// A raw Com7 row (BE datetimes, Bangkok wall clock).
function row(sellId, rowNo, uTimeBE = '2569-07-03 09:00:00', crTimeBE = '2569-02-01 00:00:00') {
  return { CrTime: crTimeBE, UTime: uTimeBE, SellID: sellId, SellBranch: 114, RowNo: rowNo, Product: `P${sellId}` };
}
const keyOf = (r) => `${r.SellBranch}|${r.SellID}|${r.RowNo}`;
const checksumOf = (r) => crc32(JSON.stringify(transformItecRow(r)));

function makeDeps({ rows = [], state = null, existing = new Map(), reserveSlotsImpl, unprovisioned = [], incompleteYears = [] } = {}) {
  const unprovisionedSet = new Set(unprovisioned);
  const incompleteSet = new Set(incompleteYears);
  const calls = {
    fetchSince: [], findByKeys: [], reserveSlots: [], batchCreate: [], batchUpdate: [],
    saveMappings: [], setState: [], boundary: [],
  };
  const gateway = {
    async batchCreate(q) { calls.batchCreate.push(q); return q.records.map((_, i) => `newrec_${calls.batchCreate.length}_${i}`); },
    async batchUpdate(q) { calls.batchUpdate.push(q); return q.records.map((r) => r.recordId); },
  };
  const deps = {
    sourceRepository: {
      async fetchChangedSince(q) { calls.fetchSince.push(q); return rows; },
    },
    mappingRepository: {
      async getState(scope) { return state; },
      async findByKeys(q) { calls.findByKeys.push(q); return existing; },
      async reserveSlots(q) {
        calls.reserveSlots.push(q);
        return reserveSlotsImpl ? reserveSlotsImpl(q) : [{ partitionNo: 1, larkTableId: 'tbl1', startIndex: 0, count: q.count }];
      },
      async saveMappings(m) { calls.saveMappings.push(m); },
      async updatePartitionBoundary(q) { calls.boundary.push(q); },
      async setState(scope, patch) { calls.setState.push({ scope, patch }); },
    },
    yearRepository: {
      async getYear(year) {
        if (unprovisionedSet.has(year)) return null;
        return { year, baseId: `BASE_${year}`, status: incompleteSet.has(year) ? 'provisioning' : 'complete' };
      },
    },
    defaultSince: '2026-07-03 00:00:00',
    chunkSize: 1000,
    now: () => Date.UTC(2026, 6, 3, 5, 0, 0), // fixed
  };
  return { deps, calls, gateway };
}

test('empty state seeds the watermark from defaultSince', async () => {
  const { deps, calls } = makeDeps({ rows: [] });
  const uc = new RunIncrementalSync(deps);
  const res = await uc.execute({ gateway: {} });
  assert.equal(calls.fetchSince[0].since, '2026-07-03 00:00:00');
  assert.deepEqual(res, { since: '2026-07-03 00:00:00', newWatermark: '2026-07-03 00:00:00', scanned: 0, inserted: 0, updated: 0, skipped: 0 });
  assert.equal(calls.setState.length, 0); // nothing scanned -> no watermark write
});

test('existing state watermark is used as since', async () => {
  const { deps, calls } = makeDeps({ rows: [], state: { lastUtime: '2026-07-03 08:00:00' } });
  const uc = new RunIncrementalSync(deps);
  await uc.execute({ gateway: {} });
  assert.equal(calls.fetchSince[0].since, '2026-07-03 08:00:00');
});

test('a new row (not in mapping) is inserted via reserveSlots + batchCreate + saveMappings', async () => {
  const r = row(10, 1);
  const { deps, calls, gateway } = makeDeps({ rows: [r] });
  const uc = new RunIncrementalSync(deps);
  const res = await uc.execute({ gateway });

  assert.deepEqual(calls.reserveSlots[0], { year: 2026, count: 1 });
  assert.equal(calls.batchCreate.length, 1);
  assert.equal(calls.batchCreate[0].baseId, 'BASE_2026');
  assert.equal(calls.batchCreate[0].tableId, 'tbl1');
  assert.deepEqual(calls.batchCreate[0].records, [transformItecRow(r)]);
  assert.equal(calls.batchUpdate.length, 0);
  const saved = calls.saveMappings.flat();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].sourceKey, '114|10|1');
  assert.equal(saved[0].larkRecordId, 'newrec_1_0');
  assert.equal(saved[0].checksum, checksumOf(r));
  assert.equal(res.inserted, 1);
  assert.equal(res.updated, 0);
  assert.equal(res.skipped, 0);
});

test('a changed row (checksum differs) is updated to the existing record, not recreated', async () => {
  const r = row(10, 1);
  const existing = new Map([['114|10|1', {
    year: 2026, baseId: 'BASE_2026', sourceKey: '114|10|1', partitionNo: 5,
    larkTableId: 'tblX', larkRecordId: 'recExisting', checksum: 999999, crTime: '2026-02-01 00:00:00',
  }]]);
  const { deps, calls, gateway } = makeDeps({ rows: [r], existing });
  const uc = new RunIncrementalSync(deps);
  const res = await uc.execute({ gateway });

  assert.equal(calls.batchCreate.length, 0);
  assert.equal(calls.reserveSlots.length, 0);
  assert.equal(calls.batchUpdate.length, 1);
  assert.equal(calls.batchUpdate[0].baseId, 'BASE_2026');
  assert.equal(calls.batchUpdate[0].tableId, 'tblX');
  assert.deepEqual(calls.batchUpdate[0].records, [{ recordId: 'recExisting', fields: transformItecRow(r) }]);
  const saved = calls.saveMappings.flat();
  assert.equal(saved[0].larkRecordId, 'recExisting');
  assert.equal(saved[0].partitionNo, 5);
  assert.equal(saved[0].checksum, checksumOf(r));
  assert.deepEqual(res, { since: '2026-07-03 00:00:00', newWatermark: '2026-07-03 09:00:00', scanned: 1, inserted: 0, updated: 1, skipped: 0 });
});

test('an unchanged row (checksum equal) is skipped — no Lark call', async () => {
  const r = row(10, 1);
  const existing = new Map([['114|10|1', {
    year: 2026, baseId: 'BASE_2026', sourceKey: '114|10|1', partitionNo: 5,
    larkTableId: 'tblX', larkRecordId: 'recExisting', checksum: checksumOf(r), crTime: '2026-02-01 00:00:00',
  }]]);
  const { deps, calls, gateway } = makeDeps({ rows: [r], existing });
  const uc = new RunIncrementalSync(deps);
  const res = await uc.execute({ gateway });

  assert.equal(calls.batchCreate.length, 0);
  assert.equal(calls.batchUpdate.length, 0);
  assert.equal(calls.saveMappings.flat().length, 0);
  assert.equal(res.skipped, 1);
  assert.equal(res.newWatermark, '2026-07-03 09:00:00'); // watermark still advances past skipped rows
});

test('rows spanning two years are grouped and routed to their own base', async () => {
  const r2025 = row(1, 1, '2569-07-03 09:00:00', '2568-06-01 00:00:00'); // CrTime BE 2568 -> CE 2025
  const r2026 = row(2, 1, '2569-07-03 09:10:00', '2569-06-01 00:00:00'); // CrTime BE 2569 -> CE 2026
  const { deps, calls, gateway } = makeDeps({ rows: [r2025, r2026] });
  const uc = new RunIncrementalSync(deps);
  const res = await uc.execute({ gateway });

  const years = calls.findByKeys.map((c) => c.year).sort();
  assert.deepEqual(years, [2025, 2026]);
  const bases = calls.batchCreate.map((c) => c.baseId).sort();
  assert.deepEqual(bases, ['BASE_2025', 'BASE_2026']);
  assert.equal(res.inserted, 2);
});

test('watermark advances to the max UTime processed (as CE), stamped once', async () => {
  const rows = [row(1, 1, '2569-07-03 08:00:00'), row(2, 1, '2569-07-03 11:45:00'), row(3, 1, '2569-07-03 09:00:00')];
  const { deps, calls, gateway } = makeDeps({ rows });
  const uc = new RunIncrementalSync(deps);
  const res = await uc.execute({ gateway });
  assert.equal(res.newWatermark, '2026-07-03 11:45:00'); // max UTime, year shifted BE->CE
  assert.equal(calls.setState.length, 1);
  assert.equal(calls.setState[0].scope, 'incremental');
  assert.equal(calls.setState[0].patch.lastUtime, '2026-07-03 11:45:00');
});

test('aborts without writing anything when a row belongs to an unprovisioned year', async () => {
  const r2026 = row(1, 1, '2569-07-03 09:00:00', '2569-06-01 00:00:00'); // CE 2026 (provisioned)
  const r2015 = row(2, 1, '2569-07-03 09:10:00', '2558-06-01 00:00:00'); // CE 2015 (NOT provisioned)
  const { deps, calls, gateway } = makeDeps({ rows: [r2026, r2015], unprovisioned: [2015] });
  const uc = new RunIncrementalSync(deps);

  await assert.rejects(() => uc.execute({ gateway }), (err) => {
    assert.ok(err instanceof YearsNotProvisionedError);
    assert.deepEqual(err.years, [2015]);
    return true;
  });
  // Nothing was written anywhere — not Lark, not ops mapping, not the watermark.
  assert.equal(calls.batchCreate.length, 0);
  assert.equal(calls.batchUpdate.length, 0);
  assert.equal(calls.reserveSlots.length, 0);
  assert.equal(calls.saveMappings.length, 0);
  assert.equal(calls.setState.length, 0);
});

test('reports every missing year (unprovisioned or not yet complete), sorted', async () => {
  const rows = [
    row(1, 1, '2569-07-03 09:00:00', '2569-06-01 00:00:00'), // 2026 ok
    row(2, 1, '2569-07-03 09:10:00', '2558-06-01 00:00:00'), // 2015 missing
    row(3, 1, '2569-07-03 09:20:00', '2570-06-01 00:00:00'), // 2027 provisioning (incomplete)
  ];
  const { deps, gateway } = makeDeps({ rows, unprovisioned: [2015], incompleteYears: [2027] });
  const uc = new RunIncrementalSync(deps);
  await assert.rejects(() => uc.execute({ gateway }), (err) => {
    assert.deepEqual(err.years, [2015, 2027]);
    return true;
  });
});

test('watermark is truncated to whole seconds (DATETIME column has no sub-second precision)', async () => {
  const r = row(10, 1, '2569-07-08 20:58:00.642'); // source UTime carries milliseconds
  const { deps, calls, gateway } = makeDeps({ rows: [r] });
  const uc = new RunIncrementalSync(deps);
  const res = await uc.execute({ gateway });
  assert.equal(res.newWatermark, '2026-07-08 20:58:00'); // .642 dropped
  assert.equal(calls.setState[0].patch.lastUtime, '2026-07-08 20:58:00');
});

test('an insert batch that spans two partitions creates into each segment', async () => {
  const rows = [row(1, 1), row(2, 1), row(3, 1)];
  const reserveSlotsImpl = () => [
    { partitionNo: 1, larkTableId: 'tblA', startIndex: 49999, count: 1 },
    { partitionNo: 2, larkTableId: 'tblB', startIndex: 0, count: 2 },
  ];
  const { deps, calls, gateway } = makeDeps({ rows, reserveSlotsImpl });
  const uc = new RunIncrementalSync(deps);
  const res = await uc.execute({ gateway });
  assert.equal(calls.batchCreate.length, 2);
  assert.deepEqual(calls.batchCreate.map((c) => c.tableId), ['tblA', 'tblB']);
  assert.equal(calls.batchCreate[0].records.length, 1);
  assert.equal(calls.batchCreate[1].records.length, 2);
  assert.equal(res.inserted, 3);
});
