import { config } from './infrastructure/config/env.js';
import { getRedisClient, closeRedisClient } from './infrastructure/database/redisClient.js';
import { RedisUserRepository } from './infrastructure/repositories/RedisUserRepository.js';
import { CreateUser } from './application/use-cases/user/CreateUser.js';
import { GetUser } from './application/use-cases/user/GetUser.js';
import { ListUsers } from './application/use-cases/user/ListUsers.js';
import { DeleteUser } from './application/use-cases/user/DeleteUser.js';
import { UserController } from './infrastructure/web/controllers/UserController.js';
import { createApp } from './infrastructure/web/app.js';

/**
 * Composition root — the ONLY place that knows about concrete implementations.
 * Wires infrastructure → repositories → use-cases → controllers → web.
 */
async function bootstrap() {
  const redis = await getRedisClient();

  // Repositories (adapters)
  const userRepository = new RedisUserRepository(redis);

  // Use-cases (application)
  const userController = new UserController({
    createUser: new CreateUser({ userRepository }),
    getUser: new GetUser({ userRepository }),
    listUsers: new ListUsers({ userRepository }),
    deleteUser: new DeleteUser({ userRepository }),
  });

  // Web
  const app = createApp({ userController });
  const server = app.listen(config.port, () => {
    console.log(`[http] listening on http://localhost:${config.port} (${config.nodeEnv})`);
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[app] ${signal} received, shutting down...`);
    server.close(async () => {
      await closeRedisClient();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[app] failed to start:', err);
  process.exit(1);
});
