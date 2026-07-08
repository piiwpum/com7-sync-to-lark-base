import { YearNotProvisionedError } from '../../domain/errors.js';

/**
 * Enqueue a hard-full-sync (nuke & rebuild) job for a year. Destructive — the
 * controller must have already checked an explicit confirm flag. Idempotent: if
 * a hard_full_sync job is already active for this year, returns it instead of
 * enqueuing a duplicate. Credentials travel in job_queue.payload so the worker
 * (long-running) keeps refreshing its own Lark token.
 */
export class EnqueueHardFullSync {
  constructor({ yearRepository, jobQueue }) {
    this.yearRepository = yearRepository;
    this.jobQueue = jobQueue;
  }

  async execute({ year, appId, appSecret }) {
    const yearRow = await this.yearRepository.getYear(year);
    if (!yearRow || yearRow.status !== 'complete') throw new YearNotProvisionedError(year);

    const existing = await this.jobQueue.findActive({ type: 'hard_full_sync', year });
    if (existing) return { year, jobId: existing.id, status: existing.status };

    const jobId = await this.jobQueue.enqueue({ type: 'hard_full_sync', year, payload: { appId, appSecret } });
    return { year, jobId, status: 'ready' };
  }
}
