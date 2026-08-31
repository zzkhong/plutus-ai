/**
 * API key validation middleware for the iOS Shortcut webhook.
 */

import { Context, Next } from 'hono';
import { config } from '../config';

export async function apiKeyAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
  const providedKey = c.req.header('x-api-key');

  if (!providedKey || providedKey !== config.WEBHOOK_API_KEY) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }

  await next();
}
