/**
 * YearRepository — port over `sync_year` + `sync_partition` (MySQL instance
 * B). This is the write-through cache that lets the sync path resolve
 * partition_no -> lark_table_id without ever fetching from Lark (§3).
 * Lark remains the source of truth; this repository mirrors it.
 */
export class YearRepository {
  /** @param {number} year @returns {Promise<{year:number, baseId:string, status:string}|null>} */
  async getYear(year) {
    throw new Error('YearRepository.getYear not implemented');
  }

  /** @param {{ year:number, baseId:string, status:string }} q */
  async upsertYear(q) {
    throw new Error('YearRepository.upsertYear not implemented');
  }

  /** @param {number} year @returns {Promise<Array<{partitionNo:number, larkTableId:string, fillCount:number}>>} */
  async listPartitions(year) {
    throw new Error('YearRepository.listPartitions not implemented');
  }

  /** @param {number} year @param {Array<{partitionNo:number, larkTableId:string}>} partitions */
  async upsertPartitions(year, partitions) {
    throw new Error('YearRepository.upsertPartitions not implemented');
  }

  /** @param {number} year @param {number[]} partitionNos */
  async deletePartitions(year, partitionNos) {
    throw new Error('YearRepository.deletePartitions not implemented');
  }
}
