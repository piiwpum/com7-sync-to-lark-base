-- Track the boundary records of each partition: the first and last record
-- written into it (by insertion order during backfill/sync). Useful for
-- monitoring/debugging — see at a glance what data range a partition
-- covers without scanning sync_mapping or querying Lark.
--
-- source_key = deriveKey(row): SellBranch|SellID|RowNo(+CrTime tiebreaker),
-- matching sync_mapping.source_key (§6.1).
--
-- These columns are populated by the backfill/sync engine (P2, not yet
-- built) when it writes records into a partition — NULL until then.
ALTER TABLE sync_partition
  ADD COLUMN first_lark_record_id VARCHAR(32) NULL AFTER fill_count,
  ADD COLUMN first_source_key     VARCHAR(64) NULL AFTER first_lark_record_id,
  ADD COLUMN first_cr_time        DATETIME    NULL AFTER first_source_key,
  ADD COLUMN last_lark_record_id  VARCHAR(32) NULL AFTER first_cr_time,
  ADD COLUMN last_source_key      VARCHAR(64) NULL AFTER last_lark_record_id,
  ADD COLUMN last_cr_time         DATETIME    NULL AFTER last_source_key;
