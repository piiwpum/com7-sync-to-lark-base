/**
 * Port: durable job queue = pending-batch intent log (MySQL instance B, §10/§11).
 * Uses FOR UPDATE SKIP LOCKED (MySQL 8.0+) so multiple workers claim jobs safely.
 */
export class JobQueue {
  /**
   * Enqueue a job. `year`/`partitionNo` are real job_queue columns (not just
   * inside payload) so callers like `findActive` can filter on them directly.
   * @param {{ type:string, year?:number, partitionNo?:number, payload:object, runAfter?:Date }} job
   */
  async enqueue(job) {
    throw new Error('JobQueue.enqueue not implemented');
  }

  /**
   * Claim up to `limit` ready jobs (status=ready, run_after<=now) via SKIP LOCKED.
   * @param {{ limit:number }} q
   * @returns {Promise<object[]>}
   */
  async claim(q) {
    throw new Error('JobQueue.claim not implemented');
  }

  /** Mark a job done. `payload` optionally overwrites (e.g. to scrub secrets). @param {{ id:number, payload?:object }} q */
  async complete(q) {
    throw new Error('JobQueue.complete not implemented');
  }

  /** Mark a job permanently failed (no more retries). `payload` optionally overwrites. @param {{ id:number, payload?:object }} q */
  async fail(q) {
    throw new Error('JobQueue.fail not implemented');
  }

  /** Reschedule with backoff (attempts++, run_after, back to status=ready). @param {{ id:number, runAfter:Date, error?:string }} q */
  async retry(q) {
    throw new Error('JobQueue.retry not implemented');
  }

  /** Find an existing ready/claimed job for idempotent enqueue. @param {{ type:string, year:number }} q @returns {Promise<object|null>} */
  async findActive(q) {
    throw new Error('JobQueue.findActive not implemented');
  }

  /** Most recent job of any status for {type, year} (for status reporting). @param {{ type:string, year:number }} q @returns {Promise<object|null>} */
  async findLatest(q) {
    throw new Error('JobQueue.findLatest not implemented');
  }
}
