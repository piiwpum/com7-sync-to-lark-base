import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARTITION_COUNT, partitionName, parsePartitionNo } from '../../../src/domain/services/partition.js';

test('PARTITION_COUNT is 250', () => assert.equal(PARTITION_COUNT, 250));

test('partitionName zero-pads to 3 digits', () => {
  assert.equal(partitionName(1), 'itec_001');
  assert.equal(partitionName(42), 'itec_042');
  assert.equal(partitionName(250), 'itec_250');
});

test('parsePartitionNo parses only valid itec names', () => {
  assert.equal(parsePartitionNo('itec_001'), 1);
  assert.equal(parsePartitionNo('itec_250'), 250);
  assert.equal(parsePartitionNo('itec_1'), null);
  assert.equal(parsePartitionNo('daily_01'), null);
  assert.equal(parsePartitionNo('Table'), null);
});
