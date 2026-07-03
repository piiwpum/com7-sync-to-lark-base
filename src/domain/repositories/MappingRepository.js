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
}
