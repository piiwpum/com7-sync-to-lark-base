import mysql from 'mysql2/promise';

/**
 * Connection pool for MySQL instance A (Com7 source, READ-ONLY, Mission §1).
 * `dateStrings: true` so DATETIME columns (CrTime/UTime, Buddhist-Era years)
 * come back as raw strings — never let mysql2/JS Date interpret them, since
 * a BE-numbered year has no reliable native Date semantics across machines.
 */
export function createCom7Pool({ host, port, user, password, database }) {
  return mysql.createPool({
    host, port, user, password, database,
    waitForConnections: true,
    connectionLimit: 5,
    dateStrings: true,
  });
}
