/**
 * Port: durable mapping + pointer + state store (MySQL instance B, §6).
 * Replaces the old Redis mapping. Point lookups by (year, sourceKey).
 */
export class MappingRepository {
  /**
   * Atomically reserve `count` slots starting at the year's current partition,
   * rolling to the next partition on overflow (§10, LAST_INSERT_ID trick).
   * A single logical batch may span partitions, so this returns segments.
   * @param {{ year:number, count:number }} q
   * @returns {Promise<{ partitionNo:number, startIndex:number, count:number }[]>}
   */
  async reserveSlots(q) {
    throw new Error('MappingRepository.reserveSlots not implemented');
  }

  /**
   * Upsert mappings after Lark returns record ids. The PK (year, sourceKey)
   * enforces the collision guard (§6.1).
   * @param {import('../entities/Mapping.js').Mapping[]} mappings
   */
  async saveMappings(mappings) {
    throw new Error('MappingRepository.saveMappings not implemented');
  }

  /**
   * Look up existing mappings by source keys (for update-vs-create routing).
   * @param {{ year:number, sourceKeys:string[] }} q
   * @returns {Promise<Map<string, import('../entities/Mapping.js').Mapping>>}
   */
  async findByKeys(q) {
    throw new Error('MappingRepository.findByKeys not implemented');
  }

  /** Read a watermark/state row. @param {string} scope */
  async getState(scope) {
    throw new Error('MappingRepository.getState not implemented');
  }

  /** Advance a watermark/state row. @param {string} scope @param {object} patch */
  async setState(scope, patch) {
    throw new Error('MappingRepository.setState not implemented');
  }

  /**
   * Records the first and/or last record written into a partition
   * (sync-architecture.md §7 / migration 006) — monitoring/debug only.
   * @param {{ year:number, partitionNo:number, first?:{larkRecordId:string,sourceKey:string,crTime:string}, last?:{larkRecordId:string,sourceKey:string,crTime:string} }} q
   */
  async updatePartitionBoundary(q) {
    throw new Error('MappingRepository.updatePartitionBoundary not implemented');
  }

  /**
   * Every partition provisioned for a year, in partition_no order — drives
   * the reconciliation check/heal loop (§9).
   * @param {{ year:number }} q
   * @returns {Promise<{ partitionNo:number, larkTableId:string, fillCount:number }[]>}
   */
  async listPartitions(q) {
    throw new Error('MappingRepository.listPartitions not implemented');
  }

  /**
   * Every mapping row for one partition — reconcile L3 diff (§9): compare
   * against the table's real Lark record ids to find missing/excess.
   * @param {{ year:number, partitionNo:number }} q
   * @returns {Promise<{ sourceKey:string, larkRecordId:string }[]>}
   */
  async getMappingsForPartition(q) {
    throw new Error('MappingRepository.getMappingsForPartition not implemented');
  }

  /**
   * Directly correct a partition's fill_count after reconciliation finds it
   * drifted from the real mapped/record count (§9/§10) — NOT for normal
   * reservation (use reserveSlots for that).
   * @param {{ year:number, partitionNo:number, fillCount:number }} q
   */
  async setFillCount(q) {
    throw new Error('MappingRepository.setFillCount not implemented');
  }

  /**
   * The partition `reserveSlots` would target next (lowest partition_no
   * with fill_count below capacity), read-only — lets a caller self-heal
   * a phantom reservation (crash after reserveSlots committed but before
   * batchCreate wrote the records, §10) before reserving more on top of it.
   * @param {{ year:number }} q
   * @returns {Promise<{ partitionNo:number, larkTableId:string, fillCount:number }|null>}
   */
  async getOpenPartition(q) {
    throw new Error('MappingRepository.getOpenPartition not implemented');
  }
}
