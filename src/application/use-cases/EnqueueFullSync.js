import { YearNotProvisionedError } from '../../domain/errors.js';

/**
 * Enqueue a full-sync (backfill) job for a year. Idempotent: if a
 * ready/claimed job already exists for this year, returns it instead of
 * enqueuing a duplicate. Credentials travel in job_queue.payload so the
 * worker (a separate, possibly hours-long process) can keep refreshing its
 * own Lark token — see spec §3/§4.
 */
export class EnqueueFullSync {
  constructor({ yearRepository, jobQueue }) {
    this.yearRepository = yearRepository;
    this.jobQueue = jobQueue;
  }

  async execute({ year, appId, appSecret }) {
    const yearRow = await this.yearRepository.getYear(year);
    if (!yearRow || yearRow.status !== 'complete') throw new YearNotProvisionedError(year);

    const existing = await this.jobQueue.findActive({ type: 'full_sync', year });
    if (existing) return { year, jobId: existing.id, status: existing.status };

    const jobId = await this.jobQueue.enqueue({ type: 'full_sync', year, payload: { appId, appSecret } });
    return { year, jobId, status: 'ready' };
  }
}
