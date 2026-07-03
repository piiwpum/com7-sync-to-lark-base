import { User } from '../../../domain/entities/User.js';

/**
 * CreateUser use-case. Depends only on the repository port.
 */
export class CreateUser {
  constructor({ userRepository }) {
    this.userRepository = userRepository;
  }

  async execute({ name, email }) {
    const user = new User({ name, email });
    await this.userRepository.save(user);
    return user;
  }
}
