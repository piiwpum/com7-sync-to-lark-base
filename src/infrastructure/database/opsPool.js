import mysql from 'mysql2/promise';

/**
 * Connection pool for MySQL instance B (ops store: mapping / pointer /
 * state / queue). Never points at the Com7 source DB (instance A).
 */
export function createOpsPool({ host, port, user, password, database }) {
  return mysql.createPool({
    host, port, user, password, database,
    waitForConnections: true,
    connectionLimit: 10,
    multipleStatements: true,
  });
}
