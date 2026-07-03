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
