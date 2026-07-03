import { Router } from 'express';

/**
 * Health check. Reports process liveness, and — if an opsPool (MySQL
 * instance B) is wired in — pings it too. Com7 (instance A) is not wired
 * in yet; that lands once the source DB is ready.
 */
export function healthRoutes({ opsPool } = {}) {
  const router = Router();

  router.get('/', async (_req, res) => {
    const body = { status: 'ok', uptime: process.uptime() };

    if (opsPool) {
      try {
        await opsPool.query('SELECT 1');
        body.opsDb = 'ok';
      } catch {
        body.opsDb = 'error';
        body.status = 'degraded';
      }
    }

    res.status(body.status === 'ok' ? 200 : 503).json(body);
  });

  return router;
}
