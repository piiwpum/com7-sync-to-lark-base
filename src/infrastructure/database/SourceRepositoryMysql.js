import { deriveKey } from '../../domain/services/deriveKey.js';

const BE_OFFSET_YEARS = 543;

function beYearRange(year) {
  const yearBE = year + BE_OFFSET_YEARS;
  return { startBE: `${yearBE}-01-01 00:00:00`, endBE: `${yearBE + 1}-01-01 00:00:00` };
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

  return { fetchItecChunk, countItec, fetchBySourceKeys };
}
