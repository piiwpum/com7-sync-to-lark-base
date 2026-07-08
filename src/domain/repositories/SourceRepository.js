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
   * Rows changed since a watermark (UTime >= since) across BOTH `itec` and
   * `daily_itec_temp` — incremental flow B+C (§8), deduped by deriveKey().
   * @param {{ since:string, limit:number }} q — since: CE Bangkok-wall-clock 'YYYY-MM-DD HH:mm:ss'
   * @returns {Promise<object[]>} raw rows (DB column names), ordered by UTime asc
   */
  async fetchChangedSince(q) {
    throw new Error('SourceRepository.fetchChangedSince not implemented');
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
