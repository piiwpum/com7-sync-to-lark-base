import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beDateStringToEpochMs, epochMsToUtcDatetimeString } from '../../../src/domain/services/dateConversion.js';

test('converts a BE datetime string to the correct CE epoch ms (Asia/Bangkok wall clock)', () => {
  // 2569-05-14 14:12:43.573 BE == 2026-05-14 14:12:43.573 Bangkok time (UTC+7)
  const ms = beDateStringToEpochMs('2569-05-14 14:12:43.573');
  const d = new Date(ms);
  assert.equal(d.toISOString(), '2026-05-14T07:12:43.573Z'); // 14:12:43+07:00 -> 07:12:43Z
});

test('handles datetimes with no fractional seconds', () => {
  const ms = beDateStringToEpochMs('2569-01-01 00:00:00');
  assert.equal(new Date(ms).toISOString(), '2025-12-31T17:00:00.000Z');
});

test('throws on an unrecognized format', () => {
  assert.throws(() => beDateStringToEpochMs('not-a-date'));
});

test('epochMsToUtcDatetimeString formats to whole-second UTC', () => {
  const ms = Date.UTC(2026, 4, 14, 7, 12, 43, 573); // 2026-05-14T07:12:43.573Z
  assert.equal(epochMsToUtcDatetimeString(ms), '2026-05-14 07:12:43');
});
