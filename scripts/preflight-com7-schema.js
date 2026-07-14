/**
 * Deploy-day pre-flight: verify the REAL Com7 source DB matches every
 * assumption the code hard-codes, BEFORE turning the sync on.
 *
 * Read-only — issues only SHOW / SELECT. Point COM7_DB_* in .env at the real
 * DB, then:  node scripts/preflight-com7-schema.js
 *
 * Exit code 0 = all critical checks passed. Non-zero = at least one FAIL.
 * Why this exists: a schema mismatch mostly does NOT crash the service — a
 * wrong column name silently writes null, and a CE-vs-BE mismatch makes every
 * year-query return nothing with no error. You must detect it, not discover it.
 */
import 'dotenv/config';
import { config } from '../src/infrastructure/config/env.js';
import { createCom7Pool } from '../src/infrastructure/database/com7Pool.js';
import { ITEC_FIELD_NAMES } from '../src/infrastructure/config/itecFieldSchema.js';

const HIST = 'itec';        // historical table
const TODAY = 'itec-today'; // today table (hyphen -> needs backticks)
const STRUCTURAL = ['SellBranch', 'SellID', 'RowNo', 'CrTime', 'UTime']; // load-bearing cols
const SELL_ROW_INDEX = ['SellID', 'RowNo']; // cursor pagination depends on this

const results = [];
const record = (level, name, detail) => results.push({ level, name, detail });
const PASS = (n, d) => record('PASS', n, d);
const FAIL = (n, d) => record('FAIL', n, d);
const WARN = (n, d) => record('WARN', n, d);

async function tableExists(pool, name) {
  const [rows] = await pool.query('SHOW TABLES LIKE ?', [name]);
  return rows.length > 0;
}

async function columnNames(pool, table) {
  const [rows] = await pool.query(`SHOW COLUMNS FROM \`${table}\``);
  return rows.map((r) => r.Field);
}

async function main() {
  const pool = createCom7Pool(config.com7Db);
  try {
    // 1) tables present
    const hasHist = await tableExists(pool, HIST);
    const hasToday = await tableExists(pool, TODAY);
    hasHist ? PASS('1. table `itec`', 'found') : FAIL('1. table `itec`', 'NOT FOUND -> fix SourceRepositoryMysql.js');
    hasToday ? PASS('1. table `itec-today`', 'found') : FAIL('1. table `itec-today`', 'NOT FOUND -> fix SourceRepositoryMysql.js:58');
    if (!hasHist) { report(); process.exit(1); return; } // nothing else checkable

    const cols = await columnNames(pool, HIST);
    const colSet = new Set(cols);

    // 2) every schema (payload) column exists, exact name + case
    const missingPayload = ITEC_FIELD_NAMES.filter((n) => !colSet.has(n));
    missingPayload.length === 0
      ? PASS('2. payload columns', `all ${ITEC_FIELD_NAMES.length} present`)
      : FAIL('2. payload columns', `MISSING (will silently null on Lark): ${missingPayload.join(', ')} -> fix itecFieldSchema.js RAW`);

    // 3) structural columns exist (identity / cursor / watermark)
    const missingStruct = STRUCTURAL.filter((n) => !colSet.has(n));
    missingStruct.length === 0
      ? PASS('3. structural columns', STRUCTURAL.join(', '))
      : FAIL('3. structural columns', `MISSING (breaks identity/cursor/watermark): ${missingStruct.join(', ')}`);

    // extra source columns are harmless (SELECT * but only RAW fields are read) — informational
    const extra = cols.filter((c) => !ITEC_FIELD_NAMES.includes(c) && !STRUCTURAL.includes(c));
    if (extra.length) WARN('   extra source columns (ignored, OK)', extra.join(', '));

    // 4) an index whose first two columns are (SellID, RowNo)
    const [idx] = await pool.query(`SHOW INDEX FROM \`${HIST}\``);
    const byKey = new Map();
    for (const r of idx) {
      if (!byKey.has(r.Key_name)) byKey.set(r.Key_name, []);
      byKey.get(r.Key_name)[r.Seq_in_index - 1] = r.Column_name;
    }
    const covering = [...byKey.entries()].find(([, c]) => c[0] === SELL_ROW_INDEX[0] && c[1] === SELL_ROW_INDEX[1]);
    covering
      ? PASS('4. cursor index (SellID,RowNo)', `satisfied by \`${covering[0]}\``)
      : FAIL('4. cursor index (SellID,RowNo)', 'NO index leads with (SellID,RowNo) -> full-scan pagination, add idx or expect very slow full sync');

    // 5) BE vs CE — sample a CrTime year
    if (colSet.has('CrTime')) {
      const [[sample]] = await pool.query(`SELECT CrTime FROM \`${HIST}\` WHERE CrTime IS NOT NULL LIMIT 1`);
      const yr = sample?.CrTime ? Number(String(sample.CrTime).slice(0, 4)) : NaN;
      if (Number.isNaN(yr)) WARN('5. BE/CE year', 'no sampleable CrTime row');
      else if (yr >= 2400 && yr <= 2700) PASS('5. BE/CE year', `CrTime="${sample.CrTime}" -> Buddhist-Era (expected)`);
      else if (yr >= 1900 && yr <= 2100) FAIL('5. BE/CE year', `CrTime="${sample.CrTime}" -> looks CE, code assumes BE(+543). Fix dateConversion.js + beYearRange/ceDatetimeToBeString`);
      else WARN('5. BE/CE year', `CrTime="${sample.CrTime}" -> unrecognized year, inspect manually`);
    }

    // 6) identity uniqueness (SellBranch|SellID|RowNo) — capped scan so it's cheap
    if (missingStruct.length === 0) {
      const [dups] = await pool.query(
        `SELECT 1 FROM (SELECT SellBranch,SellID,RowNo FROM \`${HIST}\` GROUP BY SellBranch,SellID,RowNo HAVING COUNT(*)>1 LIMIT 1) d`,
      );
      dups.length === 0
        ? PASS('6. identity uniqueness', 'no dup on (SellBranch,SellID,RowNo)')
        : FAIL('6. identity uniqueness', 'DUPLICATE identity found -> deriveKey collisions, rows will overwrite each other on Lark');
    } else {
      WARN('6. identity uniqueness', 'skipped (structural columns missing)');
    }

    // 7) privileges — should be read-only
    const [grants] = await pool.query('SHOW GRANTS');
    const flat = grants.map((g) => Object.values(g)[0]).join(' ; ');
    const writey = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ALL PRIVILEGES)\b/i.test(flat);
    writey
      ? WARN('7. read-only user', `user has write grants — tighten to SELECT only.\n     ${flat}`)
      : PASS('7. read-only user', 'SELECT-only');
  } finally {
    await pool.end();
  }
  report();
  process.exit(results.some((r) => r.level === 'FAIL') ? 1 : 0);
}

function report() {
  const icon = { PASS: '  ✓', FAIL: '  ✗', WARN: '  !' };
  console.log(`\nCom7 source pre-flight — ${config.com7Db.host}/${config.com7Db.database}\n`);
  for (const r of results) console.log(`${icon[r.level]} ${r.name}: ${r.detail}`);
  const fails = results.filter((r) => r.level === 'FAIL').length;
  const warns = results.filter((r) => r.level === 'WARN').length;
  console.log(`\n${fails === 0 ? 'READY' : 'NOT READY'} — ${fails} fail, ${warns} warn\n`);
}

main().catch((err) => {
  console.error('[preflight] could not run:', err.message);
  process.exit(2);
});
