/**
 * Port: LarkBase API. The ONLY component that talks to Lark.
 * NEVER fetch records to resolve ids in the sync path (§3) — use the mapping.
 * batchCreate MUST return record ids in input order (verify in P0).
 */
export class LarkGateway {
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

  /** Resolve if base exists/accessible; throw BaseNotFoundError otherwise. @param {string} baseId */
  async getBase(baseId) {
    throw new Error('LarkGateway.getBase not implemented');
  }

  /** @param {string} baseId @returns {Promise<Array<{tableId:string,name:string}>>} */
  async listTables(baseId) {
    throw new Error('LarkGateway.listTables not implemented');
  }

  /** @param {string} baseId @param {string} name @param {object[]} fields @returns {Promise<string>} tableId */
  async createTable(baseId, name, fields) {
    throw new Error('LarkGateway.createTable not implemented');
  }

  /** @param {string} baseId @param {string} tableId */
  async deleteTable(baseId, tableId) {
    throw new Error('LarkGateway.deleteTable not implemented');
  }

  /** @param {string} baseId @param {string} tableId @returns {Promise<string[]>} field names */
  async listFields(baseId, tableId) {
    throw new Error('LarkGateway.listFields not implemented');
  }

  /** @param {string} baseId @param {string} tableId @param {object} field */
  async createField(baseId, tableId, field) {
    throw new Error('LarkGateway.createField not implemented');
  }
}
