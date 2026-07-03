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

test('listTables aggregates pages and maps id->tableId', async () => {
  let page = 0;
  const g = gw(stub(() => (page++ === 0
    ? { code: 0, data: { tables: [{ id: 't1', name: 'itec_001' }], has_more: true, page_token: 'p2' } }
    : { code: 0, data: { tables: [{ id: 't2', name: 'Table' }], has_more: false } })));
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
