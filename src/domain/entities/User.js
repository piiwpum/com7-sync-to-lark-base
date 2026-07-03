import { randomUUID } from 'node:crypto';

/**
 * User entity — pure business object, framework/DB agnostic.
 */
export class User {
  constructor({ id, name, email, createdAt }) {
    this.id = id ?? randomUUID();
    this.name = name;
    this.email = email;
    this.createdAt = createdAt ?? new Date().toISOString();

    this.validate();
  }

  validate() {
    if (!this.name || typeof this.name !== 'string') {
      throw new DomainError('name is required');
    }
    if (!this.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email)) {
      throw new DomainError('a valid email is required');
    }
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      email: this.email,
      createdAt: this.createdAt,
    };
  }
}

/**
 * Domain-level error → surfaced as a 400 by the web layer.
 */
export class DomainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DomainError';
    this.statusCode = 400;
  }
}

export class NotFoundError extends Error {
  constructor(message = 'resource not found') {
    super(message);
    this.name = 'NotFoundError';
    this.statusCode = 404;
  }
}
