/**
 * Validates a Telegram Mini App's `initData` — the query string Telegram
 * hands the page as `Telegram.WebApp.initData` — which is how plutus-web
 * proves who is looking. Per Telegram's spec:
 *
 *   data-check-string = every field except `hash`, sorted by key, `key=value`, joined with "\n"
 *   secret            = HMAC_SHA256(key = "WebAppData", message = bot token)
 *   valid             = hex(HMAC_SHA256(key = secret, message = data-check-string)) == hash
 *
 * Only the bot token can produce that hash, so a forged or edited initData
 * fails. `auth_date` is checked too, so a leaked one stops working.
 */

import { createHmac, timingSafeEqual } from 'crypto';

/** How long an initData stays usable after Telegram issued it. */
export const INIT_DATA_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface VerifiedInitData {
  /** The Telegram user id; for a private chat with the bot it equals the chat id. */
  telegramUserId: string;
  authDate: Date;
}

export function verifyInitData(
  initData: string,
  botToken: string,
  now: Date = new Date(),
  maxAgeMs: number = INIT_DATA_MAX_AGE_MS,
): VerifiedInitData | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) {
    return null;
  }

  const fields: Array<[string, string]> = [];
  params.forEach((value, key) => fields.push([key, value]));
  const dataCheckString = fields
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheckString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) {
    return null;
  }

  const authSeconds = Number(params.get('auth_date'));
  if (!Number.isInteger(authSeconds) || authSeconds <= 0) {
    return null;
  }
  const authDate = new Date(authSeconds * 1000);
  const age = now.getTime() - authDate.getTime();
  // A little allowance for clock skew in the other direction.
  if (age > maxAgeMs || age < -5 * 60 * 1000) {
    return null;
  }

  let userId: unknown;
  try {
    userId = (JSON.parse(params.get('user') ?? 'null') as { id?: unknown } | null)?.id;
  } catch {
    return null;
  }
  if (typeof userId !== 'number' || !Number.isSafeInteger(userId)) {
    return null;
  }

  return { telegramUserId: String(userId), authDate };
}
