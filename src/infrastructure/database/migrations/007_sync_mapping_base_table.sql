-- Denormalize base_id + lark_table_id onto sync_mapping so the hot sync
-- path (flow B incremental: source_key -> update/delete on Lark) never
-- needs to JOIN sync_year/sync_partition just to know which base/table to
-- call. At ~100M rows this join avoidance matters for both query cost and
-- code simplicity — a mapping row is fully self-sufficient to act on.
--
-- partition_no is kept alongside (not replaced) — still useful for
-- partition-scoped reconciliation/debugging.
ALTER TABLE sync_mapping
  ADD COLUMN base_id       VARCHAR(64) NOT NULL AFTER year,
  ADD COLUMN lark_table_id VARCHAR(64) NOT NULL AFTER partition_no;
