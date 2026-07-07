import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLarkGateway } from '../../../src/infrastructure/lark/LarkGatewayHttp.js';
import { BaseNotFoundError } from '../../../src/domain/errors.js';

// route stub: check '/fields' before '/tables' (substring overlap)
function stub(handler) {
  return async (url, opts = {}) => ({ async json() { return handler(url, opts); } });
}
const gw = (fetchFn, extra = {}) => createLarkGateway({ token: 't', baseDomain: 'https://x', fetchFn, sleepFn: async () => {}, ...extra });

test('getBase throws BaseNotFoundError on code 91402', async () => {
  const g = gw(stub(() => ({ code: 91402, msg: 'NOTEXIST' })));
  await assert.rejects(() => g.getBase('B'), BaseNotFoundError);
});

test('getBase resolves when tables call ok', async () => {
  const g = gw(stub(() => ({ code: 0, data: { tables: [], has_more: false } })));
  await g.getBase('B'); // does not throw
});

test('listTables (bitable/v1) aggregates pages and maps table_id->tableId', async () => {
  let page = 0;
  const g = gw(stub(() => (page++ === 0
    ? { code: 0, data: { items: [{ table_id: 't1', name: 'itec_001' }], has_more: true, page_token: 'p2' } }
    : { code: 0, data: { items: [{ table_id: 't2', name: 'Table' }], has_more: false } })));
  assert.deepEqual(await g.listTables('B'), [
    { tableId: 't1', name: 'itec_001' }, { tableId: 't2', name: 'Table' },
  ]);
});

test('createTable posts flat body and returns data.id', async () => {
  let seenBody;
  const g = gw(stub((_url, opts) => { seenBody = JSON.parse(opts.body); return { code: 0, data: { id: 'tNEW' } }; }));
  const id = await g.createTable('B', 'itec_002', [{ type: 'text', name: 'Product' }]);
  assert.equal(id, 'tNEW');
  assert.deepEqual(seenBody, { name: 'itec_002', fields: [{ type: 'text', name: 'Product' }] });
});

test('createTable retries on rate-limit code then succeeds', async () => {
  let n = 0;
  const g = gw(stub(() => (n++ === 0 ? { code: 800004135, msg: 'limited' } : { code: 0, data: { id: 'tOK' } })));
  assert.equal(await g.createTable('B', 'itec_003', []), 'tOK');
  assert.equal(n, 2); // one retry
});

test('listFields returns field names from data.fields', async () => {
  const g = gw(stub(() => ({ code: 0, data: { fields: [{ name: 'A' }, { name: 'B' }], has_more: false } })));
  assert.deepEqual(await g.listFields('B', 't1'), ['A', 'B']);
});

test('deleteTable issues a DELETE with no body', async () => {
  let seenMethod, seenBody;
  const g = gw(stub((_url, opts) => { seenMethod = opts.method; seenBody = opts.body; return { code: 0 }; }));
  await g.deleteTable('B', 't1');
  assert.equal(seenMethod, 'DELETE');
  assert.equal(seenBody, undefined);
});

test('deleteTable retries on rate-limit code then succeeds', async () => {
  let n = 0;
  const g = gw(stub(() => (n++ === 0 ? { code: 1254291, msg: 'concurrent' } : { code: 0 })));
  await g.deleteTable('B', 't1'); // does not throw
  assert.equal(n, 2);
});

test('batchCreate posts bitable/v1 {records:[{fields}]} and returns record_ids in order', async () => {
  let seenUrl, seenBody;
  const g = gw(stub((url, opts) => {
    seenUrl = url;
    seenBody = JSON.parse(opts.body);
    return { code: 0, data: { records: [{ record_id: 'rec1', fields: { A: 'x1', B: 1 } }, { record_id: 'rec2', fields: { A: 'x2', B: 2 } }] } };
  }));
  const ids = await g.batchCreate({ baseId: 'B', tableId: 't1', records: [{ A: 'x1', B: 1 }, { A: 'x2', B: 2 }] });
  assert.deepEqual(ids, ['rec1', 'rec2']);
  assert.match(seenUrl, /\/open-apis\/bitable\/v1\/apps\/B\/tables\/t1\/records\/batch_create$/);
  assert.deepEqual(seenBody, { records: [{ fields: { A: 'x1', B: 1 } }, { fields: { A: 'x2', B: 2 } }] });
});

test('batchCreate retries on rate-limit code then succeeds', async () => {
  let n = 0;
  const g = gw(stub(() => (n++ === 0 ? { code: 1254290, msg: 'too many requests' } : { code: 0, data: { records: [{ record_id: 'rec1', fields: { A: 'x1' } }] } })));
  const ids = await g.batchCreate({ baseId: 'B', tableId: 't1', records: [{ A: 'x1' }] });
  assert.deepEqual(ids, ['rec1']);
  assert.equal(n, 2);
});

test('countRecords hits bitable/v1 with page_size=1 and returns data.total', async () => {
  let seenUrl;
  const g = gw(stub((url) => { seenUrl = url; return { code: 0, data: { total: 49800, items: [{}], has_more: true } }; }));
  const total = await g.countRecords({ baseId: 'B', tableId: 't1' });
  assert.equal(total, 49800);
  assert.match(seenUrl, /\/open-apis\/bitable\/v1\/apps\/B\/tables\/t1\/records\?page_size=1$/);
});

test('listRecordIds (bitable/v1) aggregates pages of record_id', async () => {
  let page = 0;
  const g = gw(stub(() => (page++ === 0
    ? { code: 0, data: { items: [{ record_id: 'r1' }, { record_id: 'r2' }], has_more: true, page_token: 'p2' } }
    : { code: 0, data: { items: [{ record_id: 'r3' }], has_more: false } })));
  assert.deepEqual(await g.listRecordIds({ baseId: 'B', tableId: 't1' }), ['r1', 'r2', 'r3']);
});

test('batchDelete posts bitable/v1 {records:[ids]} and returns deleted record_ids', async () => {
  let seenUrl, seenBody;
  const g = gw(stub((url, opts) => {
    seenUrl = url;
    seenBody = JSON.parse(opts.body);
    return { code: 0, data: { records: [{ deleted: true, record_id: 'r1' }, { deleted: true, record_id: 'r2' }] } };
  }));
  const ids = await g.batchDelete({ baseId: 'B', tableId: 't1', recordIds: ['r1', 'r2'] });
  assert.deepEqual(ids, ['r1', 'r2']);
  assert.match(seenUrl, /\/open-apis\/bitable\/v1\/apps\/B\/tables\/t1\/records\/batch_delete$/);
  assert.deepEqual(seenBody, { records: ['r1', 'r2'] });
});

test('batchDelete retries on rate-limit code then succeeds', async () => {
  let n = 0;
  const g = gw(stub(() => (n++ === 0 ? { code: 1254291, msg: 'concurrent' } : { code: 0, data: { records: [{ deleted: true, record_id: 'r1' }] } })));
  const ids = await g.batchDelete({ baseId: 'B', tableId: 't1', recordIds: ['r1'] });
  assert.deepEqual(ids, ['r1']);
  assert.equal(n, 2);
});
