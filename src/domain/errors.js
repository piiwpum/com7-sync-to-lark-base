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

/** Raised when incremental sync is blocked because a background job is active. */
export class BackgroundSyncJobRunningError extends Error {
  constructor(jobs) {
    super('background sync job is running');
    this.name = 'BackgroundSyncJobRunningError';
    this.jobs = jobs;
  }
}
