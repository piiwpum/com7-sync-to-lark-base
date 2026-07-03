import { LarkAuthError } from '../../domain/errors.js';

/**
 * Exchanges Lark app credentials for a tenant_access_token and caches it,
 * keyed by app_id, until shortly before it expires. `fetch` and `now` are
 * injectable for testing. The app_secret is never logged.
 */
export function createTokenCache({ baseDomain, fetchFn = fetch, now = Date.now }) {
  const store = new Map(); // appId -> { token, expiresAt }

  async function getToken(appId, appSecret) {
    const cached = store.get(appId);
    if (cached && cached.expiresAt > now()) return cached.token;

    const res = await fetchFn(`${baseDomain}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    const body = await res.json();
    if (body.code !== 0) throw new LarkAuthError(body.msg || `token exchange failed (code ${body.code})`);

    const expiresAt = now() + (body.expire - 60) * 1000; // refresh 60s early
    store.set(appId, { token: body.tenant_access_token, expiresAt });
    return body.tenant_access_token;
  }

  return { getToken };
}
