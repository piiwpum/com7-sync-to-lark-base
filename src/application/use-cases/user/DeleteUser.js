import { NotFoundError } from '../../../domain/entities/User.js';

export class DeleteUser {
  constructor({ userRepository }) {
    this.userRepository = userRepository;
  }

  async execute(id) {
    const deleted = await this.userRepository.delete(id);
    if (!deleted) throw new NotFoundError(`user ${id} not found`);
  }
}
