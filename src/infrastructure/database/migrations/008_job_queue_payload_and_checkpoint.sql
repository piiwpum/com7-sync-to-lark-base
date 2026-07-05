-- job_queue: generalize source_keys -> payload (per-job-type parameters;
-- full_sync jobs store {appId, appSecret} here so the worker can refresh
-- Lark tokens for the job's whole (possibly hours-long) duration).
-- claimed_at lets an operator see how long a job has been claimed.
ALTER TABLE job_queue
  CHANGE COLUMN source_keys payload JSON NULL,
  ADD COLUMN claimed_at DATETIME NULL AFTER status;

-- sync_state: full-sync's resume cursor is a compound (SellID, RowNo) pair,
-- not a single BIGINT, so it needs a flexible JSON checkpoint alongside the
-- existing scalar columns.
ALTER TABLE sync_state
  ADD COLUMN checkpoint JSON NULL AFTER last_id;

