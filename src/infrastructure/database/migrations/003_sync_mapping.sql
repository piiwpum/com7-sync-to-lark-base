-- The durable source_key -> lark_record_id + checksum mapping
-- (sync-architecture.md §6/§6.1). Largest table (~100M rows at full scale).
--
-- source_key = deriveKey(row): SellBranch|SellID|RowNo(+CrTime tiebreaker).
-- PRIMARY KEY (year, source_key) is the collision guard: a duplicate key
-- from a different row fails the INSERT instead of silently overwriting.
--
-- Partitioned by year (LIST) so a year's data can be dropped/rebuilt as a
-- single ALTER TABLE ... DROP PARTITION, independent of other years.
-- Partitions are pre-declared for 2016-2035. Adding a year outside this
-- range requires: ALTER TABLE sync_mapping ADD PARTITION (PARTITION pYYYY
-- VALUES IN (YYYY)); this is an ops step, not yet automated.
CREATE TABLE sync_mapping (
  year            INT           NOT NULL,
  source_key      VARCHAR(64)   NOT NULL,
  partition_no    SMALLINT      NOT NULL,
  lark_record_id  VARCHAR(32)   NOT NULL,
  checksum        INT UNSIGNED  NOT NULL,
  cr_time         DATETIME      NOT NULL,
  u_time          DATETIME      NOT NULL,
  PRIMARY KEY (year, source_key),
  KEY idx_watermark (year, u_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
PARTITION BY LIST (year) (
  PARTITION p2016 VALUES IN (2016),
  PARTITION p2017 VALUES IN (2017),
  PARTITION p2018 VALUES IN (2018),
  PARTITION p2019 VALUES IN (2019),
  PARTITION p2020 VALUES IN (2020),
  PARTITION p2021 VALUES IN (2021),
  PARTITION p2022 VALUES IN (2022),
  PARTITION p2023 VALUES IN (2023),
  PARTITION p2024 VALUES IN (2024),
  PARTITION p2025 VALUES IN (2025),
  PARTITION p2026 VALUES IN (2026),
  PARTITION p2027 VALUES IN (2027),
  PARTITION p2028 VALUES IN (2028),
  PARTITION p2029 VALUES IN (2029),
  PARTITION p2030 VALUES IN (2030),
  PARTITION p2031 VALUES IN (2031),
  PARTITION p2032 VALUES IN (2032),
  PARTITION p2033 VALUES IN (2033),
  PARTITION p2034 VALUES IN (2034),
  PARTITION p2035 VALUES IN (2035)
);
