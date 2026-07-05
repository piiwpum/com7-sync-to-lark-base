const BE_OFFSET_YEARS = 543;

/**
 * SourceRepository adapter over Com7's `itec` table (instance A, read-only).
 * Cursor pagination uses (SellID, RowNo) — the only index on this table
 * (`idx_itec_sell_row`); there is no PK and no index on CrTime (confirmed
 * live on the mock DB, 2026-07-03), so year-filtering is a filtered scan.
 */
export function createSourceRepository(pool) {
  async function fetchItecChunk({ year, afterCursor, limit }) {
    const yearBE = year + BE_OFFSET_YEARS;
    const startBE = `${yearBE}-01-01 00:00:00`;
    const endBE = `${yearBE + 1}-01-01 00:00:00`;
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

  return { fetchItecChunk };
}
