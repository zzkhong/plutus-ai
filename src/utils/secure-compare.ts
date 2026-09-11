/**
 * Constant-time string comparison for shared secrets (the Telegram webhook
 * secret, CRON_SECRET), so response timing can't be used to guess them a
 * character at a time.
 */

import { timingSafeEqual } from 'crypto';

export function safeEqual(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
