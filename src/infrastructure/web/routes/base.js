import { Router } from 'express';

/**
 * `/base` control-plane routes. `larkAuth` runs first so every handler gets a
 * request-scoped `req.larkGateway` built from the header credentials.
 */
export function baseRoutes({ larkAuth, baseController }) {
  const router = Router();
  router.post('/init', larkAuth, baseController.init);
  return router;
}
