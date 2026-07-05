/** Read-only full-sync status for a year — job_queue (latest job) + sync_state (checkpoint), no Lark call. */
export class GetFullSyncStatus {
  constructor({ jobQueue, mappingRepository }) {
    this.jobQueue = jobQueue;
    this.mappingRepository = mappingRepository;
  }

  async execute({ year }) {
    const job = await this.jobQueue.findLatest({ type: 'full_sync', year });
    if (!job) {
      return { year, jobStatus: 'not_started', jobId: null, attempts: 0, checkpoint: null, lastRunAt: null };
    }
    const state = await this.mappingRepository.getState(`full_sync:${year}`);
    return {
      year,
      jobStatus: job.status,
      jobId: job.id,
      attempts: job.attempts,
      checkpoint: state?.checkpoint ?? null,
      lastRunAt: state?.lastRunAt ?? null,
    };
  }
}
