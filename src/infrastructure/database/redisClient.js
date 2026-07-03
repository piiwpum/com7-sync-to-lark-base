import { createClient } from 'redis';
import { config } from '../config/env.js';

let client;

/**
 * Lazily create and connect a singleton Redis client.
 */
export async function getRedisClient() {
  if (client?.isOpen) return client;

  client = createClient({ url: config.redisUrl });
  client.on('error', (err) => console.error('[redis] client error:', err.message));
  await client.connect();
  console.log(`[redis] connected → ${config.redisUrl}`);
  return client;
}

export async function closeRedisClient() {
  if (client?.isOpen) {
    await client.quit();
    console.log('[redis] connection closed');
  }
}
