import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which migration filenames (from `available`) have not yet been applied
 * (per `applied`), in the order they should run. Pure — no I/O.
 */
export function pendingMigrations(available, applied) {
  const appliedSet = new Set(applied);
  return [...available].filter((f) => !appliedSet.has(f)).sort();
}

/**
 * Strips `--` line comments (to end of line) before statement-splitting.
 * Migration files document *why* above each statement, and those comments
 * routinely contain semicolons in prose (e.g. "generalize X -> Y (params;
 * see below)") — splitting on `;` before stripping comments would treat
 * that prose semicolon as a statement terminator.
 */
function stripLineComments(sql) {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/**
 * Splits a migration file's raw SQL into individual statements on top-level
 * semicolons (after stripping `--` comments). Lets a single migration file
 * contain multiple ALTER/CREATE statements without needing
 * `multipleStatements: true` on the connection pool — that flag would apply
 * to every query the pool ever runs (the app's live HTTP/worker traffic
 * included), which is unnecessary SQL-injection surface for what is really
 * just a migration-runner concern. Fine for our plain DDL migrations (no
 * stored procedures/triggers, no string literals containing `;`).
 */
function splitStatements(sql) {
  return stripLineComments(sql).split(';').map((s) => s.trim()).filter(Boolean);
}

/**
 * Apply every pending .sql file in `migrationsDir` against `pool`, tracked in
 * a `schema_migrations` table. CREATE/ALTER TABLE statements in MySQL are not
 * transactional, so each migration just runs its statement(s) then records
 * itself — there is no partial-transaction rollback for DDL.
 */
export async function runMigrations({ pool, migrationsDir }) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    VARCHAR(255) NOT NULL PRIMARY KEY,
      applied_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const [rows] = await pool.query('SELECT filename FROM schema_migrations');
  const applied = rows.map((r) => r.filename);
  const available = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
  const pending = pendingMigrations(available, applied);

  for (const filename of pending) {
    const sql = readFileSync(join(migrationsDir, filename), 'utf8');
    for (const statement of splitStatements(sql)) {
      await pool.query(statement);
    }
    await pool.query('INSERT INTO schema_migrations (filename) VALUES (?)', [filename]);
  }

  return { applied: pending };
}
