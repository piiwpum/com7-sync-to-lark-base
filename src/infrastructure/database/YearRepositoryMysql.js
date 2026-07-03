/**
 * YearRepository adapter over MySQL instance B (`sync_year` + `sync_partition`).
 * Pool is injected (mysql2/promise pool or a fake with the same `.query` shape).
 */
export function createYearRepository(pool) {
  async function getYear(year) {
    const [rows] = await pool.query('SELECT year, base_id, status FROM sync_year WHERE year = ?', [year]);
    if (rows.length === 0) return null;
    const r = rows[0];
    return { year: r.year, baseId: r.base_id, status: r.status };
  }

  async function upsertYear({ year, baseId, status }) {
    await pool.query(
      `INSERT INTO sync_year (year, base_id, status) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE base_id = VALUES(base_id), status = VALUES(status)`,
      [year, baseId, status],
    );
  }

  async function listPartitions(year) {
    const [rows] = await pool.query(
      'SELECT partition_no, lark_table_id, fill_count FROM sync_partition WHERE year = ? ORDER BY partition_no',
      [year],
    );
    return rows.map((r) => ({ partitionNo: r.partition_no, larkTableId: r.lark_table_id, fillCount: r.fill_count }));
  }

  async function upsertPartitions(year, partitions) {
    if (partitions.length === 0) return;
    const rows = partitions.map((p) => [year, p.partitionNo, p.larkTableId]);
    await pool.query(
      `INSERT INTO sync_partition (year, partition_no, lark_table_id) VALUES ?
       ON DUPLICATE KEY UPDATE lark_table_id = VALUES(lark_table_id)`,
      [rows],
    );
  }

  async function deletePartitions(year, partitionNos) {
    if (partitionNos.length === 0) return;
    await pool.query('DELETE FROM sync_partition WHERE year = ? AND partition_no IN (?)', [year, partitionNos]);
  }

  return { getYear, upsertYear, listPartitions, upsertPartitions, deletePartitions };
}
