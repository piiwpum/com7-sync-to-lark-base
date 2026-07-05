import { Router } from 'express';

export function syncRoutes({ larkAuth, syncController }) {
  const router = Router();
  router.post('/full', larkAuth, syncController.init);
  router.get('/full/status', larkAuth, syncController.status);
  return router;
}
