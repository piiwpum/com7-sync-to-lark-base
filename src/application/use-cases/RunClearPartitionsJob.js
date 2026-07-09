import { clearYear } from './clearYear.js';

/**
 * Clear partitions — like hard-full-sync but CLEAR ONLY, no rebuild. Empties
 * every partition table on Lark and wipes the ops side for the year (via the
 * shared `clearYear` core), leaving the tables + their manual formulas intact
 * and the year empty. Unlike RunHardFullSyncJob it does NOT enqueue a
 * follow-up full_sync — nothing is re-inserted. The year's provisioning stays
 * `complete` (tables still exist); a later POST /sync/full would re-populate it
 * from a clean slate (clearYear already reset the full_sync checkpoint).
 *
 * Destructive + long: runs on the worker, resumable, creds in job payload.
 */
export class RunClearPartitionsJob {
  constructor({
    mappingRepository, yearRepository, jobQueue,
    tokenCache, createGateway, baseDomain,
    deleteChunkSize = 500, maxAttempts = 5, retryDelayMs = 60000, now = Date.now,
  }) {
    this.mappingRepository = mappingRepository;
    this.yearRepository = yearRepository;
    this.jobQueue = jobQueue;
    this.tokenCache = tokenCache;
    this.createGateway = createGateway;
    this.baseDomain = baseDomain;
    this.deleteChunkSize = deleteChunkSize;
    this.maxAttempts = maxAttempts;
    this.retryDelayMs = retryDelayMs;
    this.now = now;
  }

  async execute(job) {
    const { id, year, attempts, payload } = job;
    const { appId, appSecret } = payload;
    const scope = `clear_partitions:${year}`;

    try {
      await clearYear({
        year, scope, appId, appSecret,
        yearRepository: this.yearRepository,
        mappingRepository: this.mappingRepository,
        tokenCache: this.tokenCache,
        createGateway: this.createGateway,
        baseDomain: this.baseDomain,
        deleteChunkSize: this.deleteChunkSize,
      });

      // No rebuild — clear only. Drop our own checkpoint and finish.
      await this.mappingRepository.clearState({ scope });
      await this.jobQueue.complete({ id, payload: { appId } }); // scrub appSecret
    } catch (err) {
      if (attempts >= this.maxAttempts) {
        console.error(`[RunClearPartitionsJob] job ${id} attempt ${attempts}/${this.maxAttempts} -> dead:`, err);
        await this.jobQueue.fail({ id, payload: { appId } });
      } else {
        console.error(`[RunClearPartitionsJob] job ${id} attempt ${attempts}/${this.maxAttempts} -> retry:`, err);
        await this.jobQueue.retry({ id, runAfter: new Date(this.now() + this.retryDelayMs) });
      }
      throw err;
    }
  }
}
