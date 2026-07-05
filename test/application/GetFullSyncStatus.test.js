import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GetFullSyncStatus } from '../../src/application/use-cases/GetFullSyncStatus.js';

function fakeJobQueue(job) { return { async findLatest() { return job; } }; }
function fakeMappingRepo(state) { return { async getState() { return state; } }; }

test('reports "not started" when there is no job at all', async () => {
  const uc = new GetFullSyncStatus({ jobQueue: fakeJobQueue(null), mappingRepository: fakeMappingRepo(null) });
  const r = await uc.execute({ year: 2024 });
  assert.deepEqual(r, { year: 2024, jobStatus: 'not_started', jobId: null, attempts: 0, checkpoint: null, lastRunAt: null });
});

test('reports job + checkpoint together when both exist', async () => {
  const job = { id: 7, status: 'claimed', attempts: 1 };
  const state = { checkpoint: { sellId: 100, rowNo: 2 }, lastRunAt: '2026-07-03 10:00:00' };
  const uc = new GetFullSyncStatus({ jobQueue: fakeJobQueue(job), mappingRepository: fakeMappingRepo(state) });
  const r = await uc.execute({ year: 2024 });
  assert.deepEqual(r, {
    year: 2024, jobStatus: 'claimed', jobId: 7, attempts: 1,
    checkpoint: { sellId: 100, rowNo: 2 }, lastRunAt: '2026-07-03 10:00:00',
  });
});
