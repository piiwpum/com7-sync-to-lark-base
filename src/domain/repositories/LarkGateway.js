/**
 * Port: LarkBase API. The ONLY component that talks to Lark.
 * NEVER fetch records to resolve ids in the sync path (§3) — use the mapping.
 * batchCreate MUST return record ids in input order (verify in P0).
 */
export class LarkGateway {
  /** Provision a table with fields matching the itec schema (§10). @param {{ baseId:string, name:string, fields:object[] }} q @returns {Promise<string>} tableId */
  async createTable(q) {
    throw new Error('LarkGateway.createTable not implemented');
  }

  /** @param {{ baseId:string, tableId:string, records:object[] }} q @returns {Promise<string[]>} record ids, input order */
  async batchCreate(q) {
    throw new Error('LarkGateway.batchCreate not implemented');
  }

  /** @param {{ baseId:string, tableId:string, records:{recordId:string, fields:object}[] }} q */
  async batchUpdate(q) {
    throw new Error('LarkGateway.batchUpdate not implemented');
  }

  /** @param {{ baseId:string, tableId:string, recordIds:string[] }} q */
  async batchDelete(q) {
    throw new Error('LarkGateway.batchDelete not implemented');
  }

  /** Total record count of a table — reconcile L1 (§9). @param {{ baseId:string, tableId:string }} q @returns {Promise<number>} */
  async countRecords(q) {
    throw new Error('LarkGateway.countRecords not implemented');
  }
}
