// test/domain/services/transformItecRow.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transformItecRow } from '../../../src/domain/services/transformItecRow.js';

test('converts datetime fields (BE string) to epoch ms', () => {
  const row = { CrTime: '2569-05-14 14:12:43.573', UTime: '2569-05-14 14:12:43.573' };
  const out = transformItecRow(row);
  assert.equal(out.CrTime, Date.parse('2026-05-14T07:12:43.573Z'));
  assert.equal(out.UTime, Date.parse('2026-05-14T07:12:43.573Z'));
});

test('converts number fields (mysql2 decimals arrive as strings) to JS numbers', () => {
  const row = { 'MIN PRICE': '0.00', SellID: 1008889, NUMBER: 1 };
  const out = transformItecRow(row);
  assert.equal(out['MIN PRICE'], 0);
  assert.equal(out.SellID, 1008889);
  assert.equal(out.NUMBER, 1);
});

test('passes text fields through as strings', () => {
  const row = { Product: '01 019 0031', Comment: null };
  const out = transformItecRow(row);
  assert.equal(out.Product, '01 019 0031');
  assert.equal(out.Comment, null);
});

test('emits all 41 schema fields even when the source row is missing some', () => {
  const out = transformItecRow({});
  assert.equal(Object.keys(out).length, 41);
  assert.equal(out.CrTime, null);
  assert.equal(out.SellID, null);
  assert.equal(out.Product, null);
});
