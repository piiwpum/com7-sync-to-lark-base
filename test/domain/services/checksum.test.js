import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from '../../../src/domain/services/checksum.js';

test('is deterministic for the same input', () => {
  assert.equal(crc32('hello'), crc32('hello'));
});

test('differs for different input', () => {
  assert.notEqual(crc32('hello'), crc32('hellp'));
});

test('matches the well-known CRC-32 of "123456789"', () => {
  // Standard CRC-32 (IEEE 802.3) check value for the ASCII string "123456789".
  assert.equal(crc32('123456789'), 0xcbf43926);
});
