/**
 * Port: durable job queue = pending-batch intent log (MySQL instance B, §10/§11).
 * Uses FOR UPDATE SKIP LOCKED (MySQL 8.0+) so multiple workers claim jobs safely.
 */
export class JobQueue {
  /**
   * Enqueue a job. Designed to run inside the SAME transaction as the state
   * write that produced it (transactional enqueue → no dual-write gap).
   * @param {{ type:string, payload:object, runAfter?:Date }} job
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

  /** Mark a job done. @param {number} id */
  async complete(id) {
    throw new Error('JobQueue.complete not implemented');
  }

  /** Reschedule with backoff (attempts++, run_after). @param {{ id:number, runAfter:Date, error?:string }} q */
  async retry(q) {
    throw new Error('JobQueue.retry not implemented');
  }
}
