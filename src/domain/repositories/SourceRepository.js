/**
 * Port: read-only access to the Com7 source DB (MySQL instance A).
 * ONE-WAY — this layer must NEVER write back to Com7 (Mission §1).
 */
export class SourceRepository {
  /**
   * A chunk of itec rows for backfill, keyed by an ascending cursor.
   * @param {{ year:number, afterCursor?:string|number, limit:number }} q
   * @returns {Promise<object[]>}
   */
  async fetchItecChunk(q) {
    throw new Error('SourceRepository.fetchItecChunk not implemented');
  }

  /**
   * Rows changed since a watermark (UTime > since) — incremental flow B (§8).
   * @param {{ since:Date, limit:number }} q
   * @returns {Promise<object[]>}
   */
  async fetchChangedSince(q) {
    throw new Error('SourceRepository.fetchChangedSince not implemented');
  }

  /** Current-day rows from daily_itec_temp — flow C (§8). @returns {Promise<object[]>} */
  async fetchDaily() {
    throw new Error('SourceRepository.fetchDaily not implemented');
  }

  /** count(*) of a year's itec — reconcile L1 (§9). @param {number} year @returns {Promise<number>} */
  async countItec(year) {
    throw new Error('SourceRepository.countItec not implemented');
  }
}
