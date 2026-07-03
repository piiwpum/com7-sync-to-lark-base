import express from 'express';
import { healthRoutes } from './routes/health.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';

/**
 * Build the Express control plane (§5). Dependencies are injected so the web
 * layer stays decoupled from how pools/repositories/use-cases are constructed.
 */
export function createApp(deps = {}) {
  const app = express();

  app.use(express.json());

  app.use('/health', healthRoutes(deps));
  // Control-plane routes (/years, /daily/clear, /reconcile, /status) land here
  // as their use-cases arrive in later phases.

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
