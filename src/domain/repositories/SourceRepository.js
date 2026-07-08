/**
 * Port: read-only access to the Com7 source DB (MySQL instance A).
 * ONE-WAY — this layer must NEVER write back to Com7 (Mission §1).
 */
export class SourceRepository {
  /**
   * A chunk of itec rows for a year, ordered by (SellID, RowNo) ascending —
   * that's the only index Com7's `itec` table has (no PK, no CrTime index).
   * @param {{ year:number, afterCursor?:{sellId:number, rowNo:number}|null, limit:number }} q
   * @returns {Promise<object[]>} raw rows, DB column names as keys
   */
  async fetchItecChunk(q) {
    throw new Error('SourceRepository.fetchItecChunk not implemented');
  }

  /**
   * ALL rows changed in the window (since, until] across BOTH `itec` and
   * `itec-today` — incremental flow B+C (§8), deduped by deriveKey(). `until`
   * is the sweep's high-watermark (source NOW(), see `now()`), so rows still
   * arriving are left for the next run. Unbounded row count; the caller chunks
   * in memory for Lark.
   * @param {{ since:string, until:string }} q — CE Bangkok-wall-clock 'YYYY-MM-DD HH:mm:ss'
   * @returns {Promise<object[]>} raw rows (DB column names), ordered by UTime asc
   */
  async fetchChangedSince(q) {
    throw new Error('SourceRepository.fetchChangedSince not implemented');
  }

  /**
   * The source DB's current time as a CE Asia/Bangkok wall-clock string — the
   * high-watermark captured at sweep start. Read from Com7 (not this server) so
   * there's no cross-machine clock skew, and pinned to +07:00 so it aligns with
   * UTime's wall clock regardless of the Com7 server's own timezone.
   * @returns {Promise<string>} 'YYYY-MM-DD HH:mm:ss' (CE)
   */
  async now() {
    throw new Error('SourceRepository.now not implemented');
  }

  /** count(*) of a year's itec — reconcile L1 (§9). @param {number} year @returns {Promise<number>} */
  async countItec(year) {
    throw new Error('SourceRepository.countItec not implemented');
  }

  /**
   * Point lookup by identity key — reconcile L3 heal (§9), to re-fetch a
   * specific row whose Lark record was lost. NOT for bulk scans (use
   * fetchItecChunk for those).
   * @param {{ sourceKeys:string[] }} q — each key is `deriveKey()`'s output
   * @returns {Promise<object[]>} raw rows, DB column names as keys
   */
  async fetchBySourceKeys(q) {
    throw new Error('SourceRepository.fetchBySourceKeys not implemented');
  }
}
