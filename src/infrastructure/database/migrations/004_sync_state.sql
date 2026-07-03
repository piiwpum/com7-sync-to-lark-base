-- Watermark / lastsync / last-index-sync per scope (e.g. "itec:2024",
-- "reconcile:2024", "today"). Tracks how far a sync flow has progressed so
-- incremental runs don't rescan everything (sync-architecture.md §8/§9).
CREATE TABLE sync_state (
  scope        VARCHAR(64)  NOT NULL,
  last_utime   DATETIME         NULL,
  last_id      BIGINT           NULL,
  last_run_at  DATETIME         NULL,
  status       VARCHAR(32)      NULL,
  PRIMARY KEY (scope)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
