import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crYear } from '../../../src/domain/services/sourceYear.js';

test('maps a BE CrTime string to its CE year', () => {
  assert.equal(crYear({ CrTime: '2569-05-14 09:00:00' }), 2026);
});

test('handles the year boundary', () => {
  assert.equal(crYear({ CrTime: '2560-01-01 00:00:00' }), 2017);
});

test('accepts a Date-typed CrTime (BE-numbered)', () => {
  // A JS Date whose ISO year is 2569 (BE) -> CE 2026.
  const d = new Date('2569-05-14T09:00:00.000Z');
  assert.equal(crYear({ CrTime: d }), 2026);
});
