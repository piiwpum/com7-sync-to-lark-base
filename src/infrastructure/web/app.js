import express from 'express';
import { userRoutes } from './routes/userRoutes.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';

/**
 * Build the Express app. Controllers are injected so the web layer stays
 * decoupled from how dependencies are constructed.
 */
export function createApp({ userController }) {
  const app = express();

  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api/users', userRoutes(userController));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
