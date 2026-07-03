import { LarkAuthError } from '../../../domain/errors.js';

/**
 * Reads Lark app credentials from request headers, exchanges them for a
 * (cached) tenant token, and attaches a request-scoped LarkGateway as
 * `req.larkGateway`. Missing headers or a failed exchange → 401. The
 * app_secret is never logged.
 */
export function larkAuth({ tokenCache, createGateway, baseDomain }) {
  return async function larkAuthMiddleware(req, res, next) {
    const appId = req.headers['x-lark-app-id'];
    const appSecret = req.headers['x-lark-app-secret'];
    if (!appId || !appSecret) {
      return res.status(401).json({ error: 'invalid or missing Lark credentials' });
    }
    try {
      const token = await tokenCache.getToken(appId, appSecret);
      req.larkGateway = createGateway({ token, baseDomain });
      next();
    } catch (err) {
      if (err instanceof LarkAuthError) {
        return res.status(401).json({ error: 'invalid or missing Lark credentials' });
      }
      next(err);
    }
  };
}
