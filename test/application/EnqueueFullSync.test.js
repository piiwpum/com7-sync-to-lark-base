import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnqueueFullSync } from '../../src/application/use-cases/EnqueueFullSync.js';
import { YearNotProvisionedError } from '../../src/domain/errors.js';

function fakeYearRepo(yearRow) {
  return { async getYear() { return yearRow; } };
}
function fakeJobQueue({ existing = null, enqueuedId = 1 } = {}) {
  return {
    enqueueCalls: [],
    async findActive() { return existing; },
    async enqueue(job) { this.enqueueCalls.push(job); return enqueuedId; },
  };
}

test('throws YearNotProvisionedError when year has no sync_year row', async () => {
  const uc = new EnqueueFullSync({ yearRepository: fakeYearRepo(null), jobQueue: fakeJobQueue() });
  await assert.rejects(() => uc.execute({ year: 2024, appId: 'a', appSecret: 's' }), YearNotProvisionedError);
});

test('throws YearNotProvisionedError when year status is not complete', async () => {
  const uc = new EnqueueFullSync({
    yearRepository: fakeYearRepo({ year: 2024, baseId: 'B', status: 'partial' }),
    jobQueue: fakeJobQueue(),
  });
  await assert.rejects(() => uc.execute({ year: 2024, appId: 'a', appSecret: 's' }), YearNotProvisionedError);
});

test('returns the existing job when one is already ready/claimed (idempotent)', async () => {
  const jobQueue = fakeJobQueue({ existing: { id: 9, status: 'claimed' } });
  const uc = new EnqueueFullSync({ yearRepository: fakeYearRepo({ year: 2024, baseId: 'B', status: 'complete' }), jobQueue });
  const r = await uc.execute({ year: 2024, appId: 'a', appSecret: 's' });
  assert.deepEqual(r, { year: 2024, jobId: 9, status: 'claimed' });
  assert.equal(jobQueue.enqueueCalls.length, 0);
});

test('enqueues a new job carrying credentials in the payload', async () => {
  const jobQueue = fakeJobQueue({ enqueuedId: 42 });
  const uc = new EnqueueFullSync({ yearRepository: fakeYearRepo({ year: 2024, baseId: 'B', status: 'complete' }), jobQueue });
  const r = await uc.execute({ year: 2024, appId: 'a', appSecret: 's' });
  assert.deepEqual(r, { year: 2024, jobId: 42, status: 'ready' });
  assert.deepEqual(jobQueue.enqueueCalls, [{ type: 'full_sync', year: 2024, payload: { appId: 'a', appSecret: 's' } }]);
});
