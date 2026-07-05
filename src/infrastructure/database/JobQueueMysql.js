/**
 * JobQueue adapter over MySQL instance B (`job_queue`). `claim` uses
 * FOR UPDATE SKIP LOCKED (MySQL 8.0+) so multiple workers could claim
 * different rows concurrently without blocking each other (not needed
 * yet with a single worker, but correct if that changes later).
 */
export function createJobQueue(pool) {
  async function enqueue({ type, year, partitionNo, payload, runAfter }) {
    const [result] = await pool.query(
      'INSERT INTO job_queue (type, year, partition_no, payload, run_after) VALUES (?, ?, ?, ?, ?)',
      [type, year ?? null, partitionNo ?? null, JSON.stringify(payload ?? null), runAfter ?? new Date()],
    );
    return result.insertId;
  }

  function mapRow(r) {
    return {
      id: r.id, type: r.type, year: r.year, partitionNo: r.partition_no,
      payload: r.payload, status: r.status, attempts: r.attempts,
      runAfter: r.run_after, createdAt: r.created_at, claimedAt: r.claimed_at,
    };
  }

  async function claim({ limit }) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query(
        `SELECT * FROM job_queue WHERE status='ready' AND run_after <= NOW()
         ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      if (rows.length > 0) {
        const ids = rows.map((r) => r.id);
        await conn.query(
          `UPDATE job_queue SET status='claimed', claimed_at=NOW() WHERE id IN (?)`,
          [ids],
        );
      }
      await conn.commit();
      return rows.map(mapRow);
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async function complete({ id, payload }) {
    await pool.query(
      `UPDATE job_queue SET status='done', payload=? WHERE id=?`,
      [payload != null ? JSON.stringify(payload) : null, id],
    );
  }

  async function fail({ id, payload }) {
    await pool.query(
      `UPDATE job_queue SET status='dead', payload=? WHERE id=?`,
      [payload != null ? JSON.stringify(payload) : null, id],
    );
  }

  async function retry({ id, runAfter }) {
    await pool.query(
      `UPDATE job_queue SET status='ready', attempts = attempts + 1, run_after=? WHERE id=?`,
      [runAfter, id],
    );
  }

  async function findActive({ type, year }) {
    const [rows] = await pool.query(
      `SELECT * FROM job_queue WHERE type=? AND year=? AND status IN ('ready','claimed') ORDER BY id LIMIT 1`,
      [type, year],
    );
    return rows.length === 0 ? null : mapRow(rows[0]);
  }

  async function findLatest({ type, year }) {
    const [rows] = await pool.query(
      `SELECT * FROM job_queue WHERE type=? AND year=? ORDER BY id DESC LIMIT 1`,
      [type, year],
    );
    return rows.length === 0 ? null : mapRow(rows[0]);
  }

  return { enqueue, claim, complete, fail, retry, findActive, findLatest };
}
