import { deriveKey } from '../../domain/services/deriveKey.js';

const BE_OFFSET_YEARS = 543;

function beYearRange(year) {
  const yearBE = year + BE_OFFSET_YEARS;
  return { startBE: `${yearBE}-01-01 00:00:00`, endBE: `${yearBE + 1}-01-01 00:00:00` };
}

// A CE datetime string (Bangkok wall clock) -> BE by shifting ONLY the year
// (+543), keeping the clock identical. Never round-trip through epoch/UTC here:
// UTime is stored Bangkok wall-clock, so a tz shift would misalign by 7h.
function ceDatetimeToBeString(since) {
  const s = String(since);
  return `${Number(s.slice(0, 4)) + BE_OFFSET_YEARS}${s.slice(4)}`;
}

/**
 * SourceRepository adapter over Com7's `itec` table (instance A, read-only).
 * Cursor pagination uses (SellID, RowNo) — the only index on this table
 * (`idx_itec_sell_row`); there is no PK and no index on CrTime (confirmed
 * live on the mock DB, 2026-07-03), so year-filtering is a filtered scan.
 */
export function createSourceRepository(pool) {
  async function fetchItecChunk({ year, afterCursor, limit }) {
    const { startBE, endBE } = beYearRange(year);
    const afterSellId = afterCursor ? afterCursor.sellId : 0;
    const afterRowNo = afterCursor ? afterCursor.rowNo : 0;

    const [rows] = await pool.query(
      `SELECT * FROM itec
       WHERE CrTime >= ? AND CrTime < ?
         AND (SellID > ? OR (SellID = ? AND RowNo > ?))
       ORDER BY SellID, RowNo
       LIMIT ?`,
      [startBE, endBE, afterSellId, afterSellId, afterRowNo, limit],
    );
    return rows;
  }

  /**
   * ALL rows changed since a watermark — incremental flow B+C (§8). One scan
   * per table: reads BOTH `itec` (historical) and `itec-today` (today) for
   * `UTime >= since` with NO row limit (the caller chunks in memory for Lark),
   * then dedups by deriveKey() keeping the newer UTime (a row can sit in both
   * around the midnight merge). `since` is a CE Bangkok-wall-clock datetime
   * string; converted to BE for the query. Ordered by UTime ascending so the
   * caller can checkpoint its watermark chunk-by-chunk.
   *
   * NOTE: unbounded by design — a single call sweeps the whole backlog. The
   * result is buffered in memory, so a pathological watermark (e.g. years of
   * backlog) trades memory for one clean scan; keep the watermark current.
   */
  async function fetchChangedSince({ since }) {
    const sinceBE = ceDatetimeToBeString(since);
    const sql = 'SELECT * FROM ?? WHERE UTime >= ? ORDER BY UTime, SellID, RowNo';
    const [itecRows] = await pool.query(sql, ['itec', sinceBE]);
    const [dailyRows] = await pool.query(sql, ['itec-today', sinceBE]);

    const byKey = new Map();
    for (const r of [...itecRows, ...dailyRows]) {
      const k = deriveKey(r);
      const prev = byKey.get(k);
      if (!prev || r.UTime > prev.UTime) byKey.set(k, r);
    }
    return [...byKey.values()].sort((x, y) => (x.UTime < y.UTime ? -1 : x.UTime > y.UTime ? 1 : 0));
  }

  /** count(*) of a year's itec — reconcile L1 (§9). */
  async function countItec(year) {
    const { startBE, endBE } = beYearRange(year);
    const [[row]] = await pool.query(
      'SELECT COUNT(*) AS n FROM itec WHERE CrTime >= ? AND CrTime < ?',
      [startBE, endBE],
    );
    return row.n;
  }

  // Point lookup for reconcile L3 heal (§9) — re-fetch a specific row whose
  // Lark record was lost. Uses idx_itec_sell_row (SellID, RowNo); SellBranch
  // isn't indexed, so it's filtered in-app as a defense-in-depth match on the
  // full derived key.
  async function fetchBySourceKeys({ sourceKeys }) {
    if (sourceKeys.length === 0) return [];
    const pairs = sourceKeys.map((k) => {
      const [, sellId, rowNo] = k.split('|');
      return [Number(sellId), Number(rowNo)];
    });
    const placeholders = pairs.map(() => '(?,?)').join(',');
    const [rows] = await pool.query(
      `SELECT * FROM itec WHERE (SellID, RowNo) IN (${placeholders})`,
      pairs.flat(),
    );
    const wanted = new Set(sourceKeys);
    return rows.filter((r) => wanted.has(deriveKey(r)));
  }

  return { fetchItecChunk, fetchChangedSince, countItec, fetchBySourceKeys };
}
