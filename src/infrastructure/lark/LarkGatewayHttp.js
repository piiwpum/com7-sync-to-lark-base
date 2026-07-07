import { BaseNotFoundError } from '../../domain/errors.js';

const BASE_NOT_FOUND = 91402;
const RATE_LIMIT_CODES = new Set([1254291, 800004135, 1254290]); // concurrent-write / method-limited / too-many-requests (v1)
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * LarkGateway adapter over the base/v3 REST API. Shapes confirmed live
 * (see docs/superpowers/plans/lark-base-v3-api-notes.md). Token + fetch are
 * injected. Write calls retry on Lark rate-limit codes with backoff.
 */
export function createLarkGateway({ token, baseDomain, fetchFn = fetch, sleepFn = defaultSleep, maxRetries = 5 }) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const call = async (path, opts = {}) => {
    const res = await fetchFn(`${baseDomain}${path}`, { ...opts, headers });
    return res.json();
  };

  const fail = (label, b) => {
    const e = new Error(`${label} failed: ${b.msg} (code ${b.code})`);
    e.larkCode = b.code;
    return e;
  };

  const writeCall = async (path, { method = 'POST', body } = {}, label) => {
    for (let attempt = 0; ; attempt++) {
      const b = await call(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (b.code === 0) return b;
      if (RATE_LIMIT_CODES.has(b.code) && attempt < maxRetries) {
        await sleepFn(500 * (attempt + 1));
        continue;
      }
      throw fail(label, b);
    }
  };

  async function getBase(baseId) {
    const b = await call(`/open-apis/base/v3/bases/${baseId}/tables?page_size=1`);
    if (b.code === BASE_NOT_FOUND) throw new BaseNotFoundError(baseId);
    if (b.code !== 0) throw fail('getBase', b);
  }

  // NOTE: uses bitable/v1 (not base/v3) to list tables. base/v3 list-tables
  // caps at 20 items and returns no page_token (confirmed live), so it cannot
  // enumerate a base with >20 tables. bitable/v1 honors page_size + paginates.
  async function listTables(baseId) {
    const out = [];
    let pageToken;
    do {
      const qs = new URLSearchParams({ page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) });
      const b = await call(`/open-apis/bitable/v1/apps/${baseId}/tables?${qs}`);
      if (b.code === BASE_NOT_FOUND) throw new BaseNotFoundError(baseId);
      if (b.code !== 0) throw fail('listTables', b);
      for (const t of b.data.items ?? []) out.push({ tableId: t.table_id ?? t.id, name: t.name });
      pageToken = b.data.has_more ? b.data.page_token : undefined;
    } while (pageToken);
    return out;
  }

  async function createTable(baseId, name, fields) {
    const b = await writeCall(`/open-apis/base/v3/bases/${baseId}/tables`, { body: { name, fields } }, 'createTable');
    return b.data.id;
  }

  async function deleteTable(baseId, tableId) {
    await writeCall(`/open-apis/base/v3/bases/${baseId}/tables/${tableId}`, { method: 'DELETE' }, 'deleteTable');
  }

  async function listFields(baseId, tableId) {
    const names = [];
    let pageToken;
    do {
      const qs = new URLSearchParams({ page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) });
      const b = await call(`/open-apis/base/v3/bases/${baseId}/tables/${tableId}/fields?${qs}`);
      if (b.code !== 0) throw fail('listFields', b);
      for (const f of b.data.fields ?? []) names.push(f.name);
      pageToken = b.data.has_more ? b.data.page_token : undefined;
    } while (pageToken);
    return names;
  }

  async function createField(baseId, tableId, field) {
    await writeCall(`/open-apis/base/v3/bases/${baseId}/tables/${tableId}/fields`, { body: field }, 'createField');
  }

  // bitable/v1 (not base/v3): confirmed live cap of 1,000 records/call (v3 caps
  // at 200) with record ordering preserved (0 mismatch across 1,000 records).
  async function batchCreate({ baseId, tableId, records }) {
    const b = await writeCall(
      `/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records/batch_create`,
      { body: { records: records.map((fields) => ({ fields })) } },
      'batchCreate',
    );
    return b.data.records.map((r) => r.record_id);
  }

  // bitable/v1 list-records' `data.total` is populated even with page_size=1,
  // so this is a single cheap call regardless of table size — reconcile L1 (§9).
  async function countRecords({ baseId, tableId }) {
    const b = await call(`/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records?page_size=1`);
    if (b.code !== 0) throw fail('countRecords', b);
    return b.data.total;
  }

  // reconcile L3 deep-verify ONLY (§9) — NEVER call from the regular sync path.
  async function listRecordIds({ baseId, tableId }) {
    const out = [];
    let pageToken;
    do {
      const qs = new URLSearchParams({ page_size: '500', ...(pageToken ? { page_token: pageToken } : {}) });
      const b = await call(`/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records?${qs}`);
      if (b.code !== 0) throw fail('listRecordIds', b);
      for (const item of b.data.items ?? []) out.push(item.record_id);
      pageToken = b.data.has_more ? b.data.page_token : undefined;
    } while (pageToken);
    return out;
  }

  // bitable/v1: confirmed cap of 500 record ids/call (caller must chunk).
  async function batchDelete({ baseId, tableId, recordIds }) {
    const b = await writeCall(
      `/open-apis/bitable/v1/apps/${baseId}/tables/${tableId}/records/batch_delete`,
      { body: { records: recordIds } },
      'batchDelete',
    );
    return b.data.records.map((r) => r.record_id);
  }

  return { getBase, listTables, createTable, deleteTable, listFields, createField, batchCreate, countRecords, listRecordIds, batchDelete };
}
