import { NotFoundError } from '../../../domain/entities/User.js';

export class GetUser {
  constructor({ userRepository }) {
    this.userRepository = userRepository;
  }

  async execute(id) {
    const user = await this.userRepository.findById(id);
    if (!user) throw new NotFoundError(`user ${id} not found`);
    return user;
  }
}
