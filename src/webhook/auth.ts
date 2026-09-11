/**
 * Resolves the user owning the `x-api-key` value for the iOS Shortcut
 * webhook. There is no global shared secret — each user gets their own
 * `users.webhook_api_key` when they complete /setup, and the key only
 * works once that account is approved, so a key handed out during
 * onboarding is inert until approval and a rejected user's key stops
 * working the moment their row is deleted.
 */

import { Context, Next } from 'hono';
import { findByWebhookKey } from '../users/service';
import { WebhookEnv } from './types';

export async function apiKeyAuthMiddleware(c: Context<WebhookEnv>, next: Next): Promise<Response | void> {
  const providedKey = c.req.header('x-api-key');

  if (!providedKey) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }

  const user = await findByWebhookKey(providedKey);
  if (!user) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }

  if (user.status !== 'approved') {
    return c.json({ status: 'error', message: 'Account is not approved yet' }, 403);
  }

  c.set('user', user);
  await next();
}
