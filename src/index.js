import { config } from './infrastructure/config/env.js';
import { createApp } from './infrastructure/web/app.js';

/**
 * Composition root — the ONLY place that wires concrete implementations
 * (pools → repositories → use-cases → controllers → web).
 *
 * Step 1: boots the Express control plane with /health only.
 * Later phases wire the MySQL pools (Step 3), repositories and use-cases here.
 */
async function bootstrap() {
  const app = createApp({});

  const server = app.listen(config.port, () => {
    console.log(`[http] listening on http://localhost:${config.port} (${config.nodeEnv})`);
  });

  const shutdown = (signal) => {
    console.log(`\n[app] ${signal} received, shutting down...`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error('[app] failed to start:', err);
  process.exit(1);
});
