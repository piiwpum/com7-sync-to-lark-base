import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EnqueueHardFullSync } from '../../src/application/use-cases/EnqueueHardFullSync.js';
import { YearNotProvisionedError } from '../../src/domain/errors.js';

function fakeYearRepo(yearRow) {
  return { async getYear() { return yearRow; } };
}
function fakeJobQueue({ existing = null, enqueuedId = 1 } = {}) {
  return {
    enqueueCalls: [],
    findActiveCalls: [],
    async findActive(q) { this.findActiveCalls.push(q); return existing; },
    async enqueue(job) { this.enqueueCalls.push(job); return enqueuedId; },
  };
}

test('throws YearNotProvisionedError when the year is not a completed base', async () => {
  const uc = new EnqueueHardFullSync({ yearRepository: fakeYearRepo(null), jobQueue: fakeJobQueue() });
  await assert.rejects(() => uc.execute({ year: 2026, appId: 'a', appSecret: 's' }), YearNotProvisionedError);
});

test('is idempotent — returns an existing active hard_full_sync job', async () => {
  const jobQueue = fakeJobQueue({ existing: { id: 5, status: 'claimed' } });
  const uc = new EnqueueHardFullSync({ yearRepository: fakeYearRepo({ year: 2026, baseId: 'B', status: 'complete' }), jobQueue });
  const r = await uc.execute({ year: 2026, appId: 'a', appSecret: 's' });
  assert.deepEqual(r, { year: 2026, jobId: 5, status: 'claimed' });
  assert.deepEqual(jobQueue.findActiveCalls[0], { type: 'hard_full_sync', year: 2026 });
  assert.equal(jobQueue.enqueueCalls.length, 0);
});

test('enqueues a hard_full_sync job carrying credentials in the payload', async () => {
  const jobQueue = fakeJobQueue({ enqueuedId: 42 });
  const uc = new EnqueueHardFullSync({ yearRepository: fakeYearRepo({ year: 2026, baseId: 'B', status: 'complete' }), jobQueue });
  const r = await uc.execute({ year: 2026, appId: 'a', appSecret: 's' });
  assert.deepEqual(r, { year: 2026, jobId: 42, status: 'ready' });
  assert.deepEqual(jobQueue.enqueueCalls, [{ type: 'hard_full_sync', year: 2026, payload: { appId: 'a', appSecret: 's' } }]);
});
