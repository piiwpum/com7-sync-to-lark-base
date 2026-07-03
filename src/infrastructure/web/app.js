import express from 'express';
import { healthRoutes } from './routes/health.js';
import { baseRoutes } from './routes/base.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';

/**
 * Build the Express control plane (§5). Dependencies are injected so the web
 * layer stays decoupled from how pools/repositories/use-cases are constructed.
 */
export function createApp({ larkAuth, baseController, opsPool } = {}) {
  const app = express();

  app.use(express.json());

  app.use('/health', healthRoutes({ opsPool }));
  if (larkAuth && baseController) {
    app.use('/base', baseRoutes({ larkAuth, baseController }));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
