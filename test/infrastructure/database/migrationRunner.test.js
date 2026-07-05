import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pendingMigrations, runMigrations } from '../../../src/infrastructure/database/migrationRunner.js';

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

function fakePool(queryHandler) {
  const calls = [];
  return { calls, async query(sql, params) { calls.push(sql); return queryHandler(sql, params); } };
}

test('runMigrations executes a multi-statement file as separate queries (no multipleStatements needed)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-test-'));
  try {
    writeFileSync(join(dir, '001_two_statements.sql'), 'ALTER TABLE a ADD COLUMN x INT;\nALTER TABLE b ADD COLUMN y INT;\n');
    const pool = fakePool((sql) => (sql.startsWith('SELECT filename') ? [[]] : [{}]));
    const { applied } = await runMigrations({ pool, migrationsDir: dir });
    assert.deepEqual(applied, ['001_two_statements.sql']);
    // schema_migrations bootstrap + SELECT + 2 ALTERs + 1 INSERT = 5 distinct query() calls
    const alters = pool.calls.filter((sql) => sql.includes('ALTER TABLE'));
    assert.deepEqual(alters, ['ALTER TABLE a ADD COLUMN x INT', 'ALTER TABLE b ADD COLUMN y INT']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
