import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GetBaseStatus } from '../../src/application/use-cases/GetBaseStatus.js';
import { YearNotProvisionedError } from '../../src/domain/errors.js';

function fakeYearRepository({ year, partitions }) {
  return {
    async getYear(y) { return year && y === year.year ? year : null; },
    async listPartitions() { return partitions; },
  };
}

test('throws YearNotProvisionedError when year has no sync_year row', async () => {
  const yr = fakeYearRepository({ year: null, partitions: [] });
  const uc = new GetBaseStatus({ partitionCount: 3, yearRepository: yr });
  await assert.rejects(() => uc.execute({ year: 2024 }), YearNotProvisionedError);
});

test('reports complete status from MySQL only (no gateway involved)', async () => {
  const yr = fakeYearRepository({
    year: { year: 2024, baseId: 'B', status: 'complete' },
    partitions: [{ partitionNo: 1, larkTableId: 't1', fillCount: 0 }, { partitionNo: 2, larkTableId: 't2', fillCount: 0 }, { partitionNo: 3, larkTableId: 't3', fillCount: 0 }],
  });
  const uc = new GetBaseStatus({ partitionCount: 3, yearRepository: yr });
  const r = await uc.execute({ year: 2024 });
  assert.deepEqual(r, { year: 2024, base: 'B', status: 'complete', total: 3, existing: 3, missing: 0, complete: true });
});

test('reports incomplete status', async () => {
  const yr = fakeYearRepository({
    year: { year: 2024, baseId: 'B', status: 'partial' },
    partitions: [{ partitionNo: 1, larkTableId: 't1', fillCount: 0 }],
  });
  const uc = new GetBaseStatus({ partitionCount: 3, yearRepository: yr });
  const r = await uc.execute({ year: 2024 });
  assert.deepEqual(r, { year: 2024, base: 'B', status: 'partial', total: 3, existing: 1, missing: 2, complete: false });
});
