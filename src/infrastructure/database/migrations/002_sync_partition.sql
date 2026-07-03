-- Partition pointer: which Lark table a partition maps to, and how full it
-- is. `fill_count` is reserved atomically during backfill via the
-- LAST_INSERT_ID(fill_count + :n) counter trick (sync-architecture.md §10).
-- No FK to sync_year — this table is written at high frequency during
-- backfill and we avoid FK-check overhead on a hot path.
CREATE TABLE sync_partition (
  year          INT       NOT NULL,
  partition_no  SMALLINT  NOT NULL,
  lark_table_id VARCHAR(64)   NULL,
  fill_count    INT       NOT NULL DEFAULT 0,
  PRIMARY KEY (year, partition_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
