import { BaseNotFoundError } from '../../domain/errors.js';

const BASE_NOT_FOUND = 91402;
const RATE_LIMIT_CODES = new Set([1254291, 800004135]); // concurrent-write / method-limited
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

  const writeCall = async (path, body, label) => {
    for (let attempt = 0; ; attempt++) {
      const b = await call(path, { method: 'POST', body: JSON.stringify(body) });
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

  async function listTables(baseId) {
    const out = [];
    let pageToken;
    do {
      const qs = new URLSearchParams({ page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) });
      const b = await call(`/open-apis/base/v3/bases/${baseId}/tables?${qs}`);
      if (b.code === BASE_NOT_FOUND) throw new BaseNotFoundError(baseId);
      if (b.code !== 0) throw fail('listTables', b);
      for (const t of b.data.tables ?? []) out.push({ tableId: t.id, name: t.name });
      pageToken = b.data.has_more ? b.data.page_token : undefined;
    } while (pageToken);
    return out;
  }

  async function createTable(baseId, name, fields) {
    const b = await writeCall(`/open-apis/base/v3/bases/${baseId}/tables`, { name, fields }, 'createTable');
    return b.data.id;
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
    await writeCall(`/open-apis/base/v3/bases/${baseId}/tables/${tableId}/fields`, field, 'createField');
  }

  return { getBase, listTables, createTable, listFields, createField };
}
