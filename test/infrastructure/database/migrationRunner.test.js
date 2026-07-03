import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingMigrations } from '../../../src/infrastructure/database/migrationRunner.js';

test('returns available files not yet applied, sorted ascending', () => {
  const available = ['003_c.sql', '001_a.sql', '002_b.sql'];
  const applied = ['001_a.sql'];
  assert.deepEqual(pendingMigrations(available, applied), ['002_b.sql', '003_c.sql']);
});

test('returns empty when everything is already applied', () => {
  assert.deepEqual(pendingMigrations(['001_a.sql'], ['001_a.sql']), []);
});

test('returns all, sorted, when nothing applied yet', () => {
  assert.deepEqual(pendingMigrations(['002_b.sql', '001_a.sql'], []), ['001_a.sql', '002_b.sql']);
});
