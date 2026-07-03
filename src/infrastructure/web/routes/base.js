import { Router } from 'express';

/**
 * `/base` control-plane routes. `larkAuth` runs first so every handler gets a
 * request-scoped `req.larkGateway` built from the header credentials.
 */
export function baseRoutes({ larkAuth, baseController }) {
  const router = Router();
  router.post('/init', larkAuth, baseController.init);
  router.post('/remove-partitions', larkAuth, baseController.removePartitions);
  // Read-only, answered entirely from MySQL — larkAuth still gates it for
  // consistency with every other control-plane route (§2.1), even though
  // the handler doesn't use req.larkGateway.
  router.get('/status', larkAuth, baseController.status);
  return router;
}
