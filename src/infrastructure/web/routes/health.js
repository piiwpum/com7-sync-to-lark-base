import { Router } from 'express';

/**
 * Health check. Step 1: reports that the process is up.
 * Step 3 will extend this to ping both MySQL pools (Com7 read + ops store).
 */
export function healthRoutes(_deps = {}) {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  return router;
}
