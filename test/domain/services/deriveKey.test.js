import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveKey } from '../../../src/domain/services/deriveKey.js';

test('joins SellBranch|SellID|RowNo', () => {
  assert.equal(deriveKey({ SellBranch: 114, SellID: 1008889, RowNo: 2 }), '114|1008889|2');
});
