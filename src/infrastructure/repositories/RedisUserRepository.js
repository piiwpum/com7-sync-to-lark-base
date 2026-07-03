import { User } from '../../domain/entities/User.js';
import { UserRepository } from '../../domain/repositories/UserRepository.js';

const KEY_PREFIX = 'user:';
const INDEX_KEY = 'users'; // Set holding all user ids.

/**
 * Redis-backed adapter implementing the UserRepository port.
 * Each user is stored as a JSON string at `user:<id>`, and every id is
 * tracked in the `users` set so we can list them without SCAN.
 */
export class RedisUserRepository extends UserRepository {
  constructor(redisClient) {
    super();
    this.client = redisClient;
  }

  #key(id) {
    return `${KEY_PREFIX}${id}`;
  }

  async save(user) {
    await this.client
      .multi()
      .set(this.#key(user.id), JSON.stringify(user.toJSON()))
      .sAdd(INDEX_KEY, user.id)
      .exec();
    return user;
  }

  async findById(id) {
    const raw = await this.client.get(this.#key(id));
    return raw ? new User(JSON.parse(raw)) : null;
  }

  async findAll() {
    const ids = await this.client.sMembers(INDEX_KEY);
    if (ids.length === 0) return [];

    const keys = ids.map((id) => this.#key(id));
    const rows = await this.client.mGet(keys);
    return rows.filter(Boolean).map((raw) => new User(JSON.parse(raw)));
  }

  async delete(id) {
    const [removed] = await this.client
      .multi()
      .del(this.#key(id))
      .sRem(INDEX_KEY, id)
      .exec();
    return removed > 0;
  }
}
