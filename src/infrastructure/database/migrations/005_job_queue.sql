-- Durable job queue = pending-batch intent log (sync-architecture.md §10/§11).
-- Workers claim rows with `SELECT ... FOR UPDATE SKIP LOCKED` (MySQL 8.0+),
-- so multiple workers can pull work concurrently without blocking on each
-- other. idx_claim supports that claim query (status + run_after scan).
CREATE TABLE job_queue (
  id            BIGINT        NOT NULL AUTO_INCREMENT,
  type          VARCHAR(32)   NOT NULL,
  year          INT               NULL,
  partition_no  SMALLINT          NULL,
  source_keys   JSON              NULL,
  status        ENUM('ready','claimed','done','dead') NOT NULL DEFAULT 'ready',
  attempts      INT           NOT NULL DEFAULT 0,
  run_after     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_claim (status, run_after)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
