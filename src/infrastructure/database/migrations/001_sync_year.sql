-- Which LarkBase base a year lives in (Decision #3, #8).
-- One row per year that has been provisioned via POST /base/init.
CREATE TABLE sync_year (
  year        INT          NOT NULL,
  base_id     VARCHAR(64)  NOT NULL,
  status      VARCHAR(32)  NOT NULL DEFAULT 'pending',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
