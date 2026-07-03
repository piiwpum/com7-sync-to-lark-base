/**
 * UserRepository — the port (interface) the domain/application layer depends on.
 * Concrete adapters (e.g. Redis) live in the infrastructure layer and must
 * implement every method below. This keeps use-cases decoupled from storage.
 */
export class UserRepository {
  /** @param {import('../entities/User.js').User} user */
  async save(user) {
    throw new Error('UserRepository.save not implemented');
  }

  /** @param {string} id @returns {Promise<import('../entities/User.js').User|null>} */
  async findById(id) {
    throw new Error('UserRepository.findById not implemented');
  }

  /** @returns {Promise<import('../entities/User.js').User[]>} */
  async findAll() {
    throw new Error('UserRepository.findAll not implemented');
  }

  /** @param {string} id @returns {Promise<boolean>} */
  async delete(id) {
    throw new Error('UserRepository.delete not implemented');
  }
}
