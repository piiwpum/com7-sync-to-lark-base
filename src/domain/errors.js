export class BaseNotFoundError extends Error {
  constructor(baseId) {
    super(`base not found: ${baseId}`);
    this.name = 'BaseNotFoundError';
    this.baseId = baseId;
  }
}

export class LarkAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LarkAuthError';
  }
}

export class YearNotProvisionedError extends Error {
  constructor(year) {
    super(`year not provisioned: ${year}`);
    this.name = 'YearNotProvisionedError';
    this.year = year;
  }
}

/**
 * Raised by incremental sync when a chunk contains rows whose CrTime year has
 * no completed Lark base to land in. The whole run aborts BEFORE any Lark/ops
 * write — provision the listed years and re-run.
 */
export class YearsNotProvisionedError extends Error {
  constructor(years) {
    super(`years not provisioned (no Lark base): ${years.join(', ')}`);
    this.name = 'YearsNotProvisionedError';
    this.years = years;
  }
}
