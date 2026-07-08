import { Mapping } from '../../domain/entities/Mapping.js';

const PARTITION_CAPACITY = 50000;

/**
 * MappingRepository adapter over MySQL instance B (sync_partition,
 * sync_mapping, sync_state). reserveSlots uses SELECT...FOR UPDATE inside a
 * transaction (row lock) rather than the LAST_INSERT_ID counter trick
 * mentioned in sync-architecture.md §10 — with a single worker (no
 * concurrent reservation contention yet, Open Q#7 deferred) this is
 * simpler to read and test, and remains correct if concurrent workers are
 * added later (they'll just serialize briefly on the row lock).
 */
export function createMappingRepository(pool) {
  async function reserveOneSegment(conn, year, remaining) {
    const [[current]] = await conn.query(
      'SELECT partition_no, lark_table_id, fill_count FROM sync_partition WHERE year=? AND fill_count < ? ORDER BY partition_no LIMIT 1 FOR UPDATE',
      [year, PARTITION_CAPACITY],
    );
    if (!current) throw new Error(`no partition capacity left for year ${year}`);
    const take = Math.min(PARTITION_CAPACITY - current.fill_count, remaining);
    const startIndex = current.fill_count;
    await conn.query(
      'UPDATE sync_partition SET fill_count = fill_count + ? WHERE year=? AND partition_no=?',
      [take, year, current.partition_no],
    );
    return { partitionNo: current.partition_no, larkTableId: current.lark_table_id, startIndex, count: take };
  }

  async function reserveSlots({ year, count }) {
    const segments = [];
    let remaining = count;
    while (remaining > 0) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const segment = await reserveOneSegment(conn, year, remaining);
        await conn.commit();
        segments.push(segment);
        remaining -= segment.count;
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }
    return segments;
  }

  async function saveMappings(mappings) {
    if (mappings.length === 0) return;
    const rows = mappings.map((m) => [
      m.year, m.baseId, m.sourceKey, m.partitionNo, m.larkTableId,
      m.larkRecordId, m.checksum, m.crTime, m.uTime,
    ]);
    await pool.query(
      `INSERT INTO sync_mapping
         (year, base_id, source_key, partition_no, lark_table_id, lark_record_id, checksum, cr_time, u_time)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         lark_table_id = VALUES(lark_table_id), lark_record_id = VALUES(lark_record_id),
         checksum = VALUES(checksum), u_time = VALUES(u_time)`,
      [rows],
    );
  }

  /**
   * Point-lookup existing mappings by (year, source_key) — drives incremental
   * update-vs-insert routing (§8.B). Returns a Map keyed by sourceKey; absent
   * keys simply aren't in the Map. Uses the PK, so no scan.
   */
  async function findByKeys({ year, sourceKeys }) {
    const found = new Map();
    if (sourceKeys.length === 0) return found;
    const [rows] = await pool.query(
      `SELECT year, base_id, source_key, partition_no, lark_table_id, lark_record_id, checksum, cr_time, u_time
         FROM sync_mapping WHERE year=? AND source_key IN (?)`,
      [year, sourceKeys],
    );
    for (const r of rows) {
      found.set(r.source_key, new Mapping({
        year: r.year, baseId: r.base_id, sourceKey: r.source_key, partitionNo: r.partition_no,
        larkTableId: r.lark_table_id, larkRecordId: r.lark_record_id, checksum: r.checksum,
        crTime: r.cr_time, uTime: r.u_time,
      }));
    }
    return found;
  }

  /** Delete a state row entirely (setState can't null fields — it COALESCEs). */
  async function clearState({ scope }) {
    await pool.query('DELETE FROM sync_state WHERE scope = ?', [scope]);
  }

  async function getState(scope) {
    const [rows] = await pool.query(
      'SELECT scope, last_utime, last_id, checkpoint, last_run_at, status FROM sync_state WHERE scope=?',
      [scope],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return { scope: r.scope, lastUtime: r.last_utime, lastId: r.last_id, checkpoint: r.checkpoint, lastRunAt: r.last_run_at, status: r.status };
  }

  async function setState(scope, patch) {
    await pool.query(
      `INSERT INTO sync_state (scope, last_utime, last_id, checkpoint, last_run_at, status)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         last_utime = COALESCE(VALUES(last_utime), last_utime),
         last_id = COALESCE(VALUES(last_id), last_id),
         checkpoint = COALESCE(VALUES(checkpoint), checkpoint),
         last_run_at = COALESCE(VALUES(last_run_at), last_run_at),
         status = COALESCE(VALUES(status), status)`,
      [scope, patch.lastUtime ?? null, patch.lastId ?? null, patch.checkpoint ? JSON.stringify(patch.checkpoint) : null,
       patch.lastRunAt ?? null, patch.status ?? null],
    );
  }

  /**
   * Records the first and/or last record written into a partition
   * (sync-architecture.md §7 / migration 006), for monitoring/debug — no
   * scan of sync_mapping needed to see what a partition covers. `first`
   * and `last` are each optional `{larkRecordId, sourceKey, crTime}`.
   */
  async function updatePartitionBoundary({ year, partitionNo, first, last }) {
    const sets = [];
    const params = [];
    if (first) {
      sets.push('first_lark_record_id = ?', 'first_source_key = ?', 'first_cr_time = ?');
      params.push(first.larkRecordId, first.sourceKey, first.crTime);
    }
    if (last) {
      sets.push('last_lark_record_id = ?', 'last_source_key = ?', 'last_cr_time = ?');
      params.push(last.larkRecordId, last.sourceKey, last.crTime);
    }
    if (sets.length === 0) return;
    params.push(year, partitionNo);
    await pool.query(`UPDATE sync_partition SET ${sets.join(', ')} WHERE year=? AND partition_no=?`, params);
  }

  /** Every partition provisioned for a year, in partition_no order — drives the reconcile check/heal loop (§9). */
  async function listPartitions({ year }) {
    const [rows] = await pool.query(
      'SELECT partition_no, lark_table_id, fill_count FROM sync_partition WHERE year=? ORDER BY partition_no',
      [year],
    );
    return rows.map((r) => ({ partitionNo: r.partition_no, larkTableId: r.lark_table_id, fillCount: r.fill_count }));
  }

  /** Every mapping row for one partition — reconcile L3 diff (§9). */
  async function getMappingsForPartition({ year, partitionNo }) {
    const [rows] = await pool.query(
      'SELECT source_key, lark_record_id FROM sync_mapping WHERE year=? AND partition_no=?',
      [year, partitionNo],
    );
    return rows.map((r) => ({ sourceKey: r.source_key, larkRecordId: r.lark_record_id }));
  }

  /** Directly correct fill_count after reconciliation (§9/§10) — not for normal reservation. */
  async function setFillCount({ year, partitionNo, fillCount }) {
    await pool.query(
      'UPDATE sync_partition SET fill_count=? WHERE year=? AND partition_no=?',
      [fillCount, year, partitionNo],
    );
  }

  // --- hard-full-sync (nuke & rebuild a year) ---

  /** Delete every sync_mapping row for a year (year is the LIST-partition key). */
  async function clearYearMappings({ year }) {
    await pool.query('DELETE FROM sync_mapping WHERE year = ?', [year]);
  }

  /**
   * Reset a year's partitions to empty: fill_count=0 and all boundary columns
   * NULL, so a fresh backfill starts from a clean slate. Deliberately keeps
   * lark_table_id — the Lark tables (and their manual formulas) still exist.
   */
  async function resetPartitionsForYear({ year }) {
    await pool.query(
      `UPDATE sync_partition SET
         fill_count = 0,
         first_lark_record_id = NULL, first_source_key = NULL, first_cr_time = NULL,
         last_lark_record_id = NULL, last_source_key = NULL, last_cr_time = NULL
       WHERE year = ?`,
      [year],
    );
  }

  /** Read-only peek at the partition reserveSlots would target next (§10). */
  async function getOpenPartition({ year }) {
    const [rows] = await pool.query(
      'SELECT partition_no, lark_table_id, fill_count FROM sync_partition WHERE year=? AND fill_count < ? ORDER BY partition_no LIMIT 1',
      [year, PARTITION_CAPACITY],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return { partitionNo: r.partition_no, larkTableId: r.lark_table_id, fillCount: r.fill_count };
  }

  return {
    reserveSlots, saveMappings, findByKeys, getState, setState, clearState, updatePartitionBoundary,
    listPartitions, getMappingsForPartition, setFillCount, getOpenPartition,
    clearYearMappings, resetPartitionsForYear,
  };
}
