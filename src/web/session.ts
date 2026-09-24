/**
 * Short-lived session tokens for plutus-web, issued once initData checks out.
 *
 * The token is `<payload>.<signature>`, both base64url: the payload is
 * `{ sub: userId, exp: epoch ms }` and the signature an HMAC-SHA256 of it
 * under WEB_SESSION_SECRET. It only names the user — every request still
 * looks the user up, so a user rejected mid-session loses access at once.
 */

import { createHmac, timingSafeEqual } from 'crypto';

export const SESSION_TTL_MS = 60 * 60 * 1000;

interface SessionPayload {
  sub: string;
  exp: number;
}

function sign(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function createSessionToken(userId: string, secret: string, now: Date = new Date()): { token: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: expiresAt.getTime() } satisfies SessionPayload)).toString(
    'base64url',
  );
  return { token: `${payload}.${sign(payload, secret).toString('base64url')}`, expiresAt };
}

/** The user id the token was issued to, or null if it's forged, malformed or expired. */
export function verifySessionToken(token: string, secret: string, now: Date = new Date()): string | null {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) {
    return null;
  }
  const expected = sign(payload, secret);
  const provided = Buffer.from(signature, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  let parsed: Partial<SessionPayload>;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed.sub !== 'string' || typeof parsed.exp !== 'number' || parsed.exp <= now.getTime()) {
    return null;
  }
  return parsed.sub;
}
