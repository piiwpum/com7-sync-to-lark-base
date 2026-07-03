import { config } from '../../config/env.js';

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'route not found' });
}

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature.
export function errorHandler(err, _req, res, _next) {
  const statusCode = err.statusCode ?? 500;

  if (statusCode >= 500) {
    console.error('[error]', err);
  }

  res.status(statusCode).json({
    error: err.message ?? 'internal server error',
    ...(config.nodeEnv === 'development' && statusCode >= 500
      ? { stack: err.stack }
      : {}),
  });
}
