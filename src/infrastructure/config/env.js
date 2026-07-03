import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
};
