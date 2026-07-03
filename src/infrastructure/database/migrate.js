import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from '../config/env.js';
import { createOpsPool } from './opsPool.js';
import { runMigrations } from './migrationRunner.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

async function main() {
  const pool = createOpsPool(config.opsDb);
  try {
    const { applied } = await runMigrations({ pool, migrationsDir });
    if (applied.length === 0) {
      console.log('[migrate] up to date, nothing to apply');
    } else {
      console.log(`[migrate] applied ${applied.length} migration(s): ${applied.join(', ')}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
