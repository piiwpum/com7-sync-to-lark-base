import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ITEC_FIELD_SCHEMA, ITEC_FIELD_NAMES } from '../../../src/infrastructure/config/itecFieldSchema.js';

test('has 41 fields with unique names', () => {
  assert.equal(ITEC_FIELD_SCHEMA.length, 41);
  assert.equal(new Set(ITEC_FIELD_NAMES).size, 41);
});

test('maps types correctly for representative fields', () => {
  const byName = Object.fromEntries(ITEC_FIELD_SCHEMA.map((f) => [f.name, f]));
  assert.deepEqual(byName['CrTime'], { type: 'datetime', name: 'CrTime', style: { format: 'yyyy-MM-dd HH:mm' } });
  assert.deepEqual(byName['SellID'], { type: 'number', name: 'SellID', style: { type: 'plain', precision: 0 } });
  assert.deepEqual(byName['GP / UNIT'], { type: 'number', name: 'GP / UNIT', style: { type: 'plain', precision: 4 } });
  assert.deepEqual(byName['MIN PRICE'], { type: 'number', name: 'MIN PRICE', style: { type: 'plain', precision: 2 } });
  assert.deepEqual(byName['Product'], { type: 'text', name: 'Product' });
});
