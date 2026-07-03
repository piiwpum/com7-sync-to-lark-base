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
 * Apply every pending .sql file in `migrationsDir` against `pool`, tracked in
 * a `schema_migrations` table. CREATE TABLE statements in MySQL are not
 * transactional, so each migration just runs its statement then records
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
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (filename) VALUES (?)', [filename]);
  }

  return { applied: pending };
}
