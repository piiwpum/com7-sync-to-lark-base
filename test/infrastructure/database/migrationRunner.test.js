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

test('runMigrations ignores semicolons inside -- line comments (regression: migration 008 has one)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-test-'));
  try {
    writeFileSync(
      join(dir, '001_commented.sql'),
      '-- generalize source_keys -> payload (per-job-type parameters;\n' +
      '-- second comment line, no trailing semicolon here\n' +
      'ALTER TABLE job_queue\n  CHANGE COLUMN source_keys payload JSON NULL,\n  ADD COLUMN claimed_at DATETIME NULL AFTER status;\n' +
      '\n-- another comment;\nALTER TABLE sync_state\n  ADD COLUMN checkpoint JSON NULL AFTER last_id;\n',
    );
    const pool = fakePool((sql) => (sql.startsWith('SELECT filename') ? [[]] : [{}]));
    const { applied } = await runMigrations({ pool, migrationsDir: dir });
    assert.deepEqual(applied, ['001_commented.sql']);
    const alters = pool.calls.filter((sql) => sql.includes('ALTER TABLE'));
    assert.equal(alters.length, 2);
    assert.match(alters[0], /^ALTER TABLE job_queue/);
    assert.match(alters[1], /^ALTER TABLE sync_state/);
    // no leftover comment-only "statement" was sent to the pool
    assert.ok(!pool.calls.some((sql) => sql.trim().startsWith('--')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runMigrations applies the real migration 008 file end-to-end against a fake pool', async () => {
  const migrationsDir = join(process.cwd(), 'src/infrastructure/database/migrations');
  const pool = fakePool((sql) => (sql.startsWith('SELECT filename') ? [[]] : [{}]));
  // Isolate to just 008 by copying it into a temp dir (avoids re-running 001-007 against the fake pool).
  const dir = mkdtempSync(join(tmpdir(), 'migrations-test-'));
  try {
    const { readFileSync, writeFileSync: write } = await import('node:fs');
    const sql008 = readFileSync(join(migrationsDir, '008_job_queue_payload_and_checkpoint.sql'), 'utf8');
    write(join(dir, '008_job_queue_payload_and_checkpoint.sql'), sql008);
    const { applied } = await runMigrations({ pool, migrationsDir: dir });
    assert.deepEqual(applied, ['008_job_queue_payload_and_checkpoint.sql']);
    const alters = pool.calls.filter((sql) => sql.includes('ALTER TABLE'));
    assert.equal(alters.length, 2, `expected 2 ALTER statements, got: ${JSON.stringify(alters)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
