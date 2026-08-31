/**
 * iOS Shortcut webhook HTTP server (Hono, served via @hono/node-server).
 * Runs on config.PORT, independent of the Telegram bot's long-polling loop.
 */

import { serve, ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { Bot } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { apiKeyAuthMiddleware } from './auth';
import { createApplePayHandler } from './routes/apple-pay';

export function createWebhookApp(bot: Bot | null): Hono {
  const app = new Hono();

  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.post('/api/apple-pay', apiKeyAuthMiddleware, createApplePayHandler(bot));

  return app;
}

export function startWebhookServer(bot: Bot | null): ServerType | null {
  if (!config.WEBHOOK_API_KEY) {
    logger.error(
      'Webhook server not started: WEBHOOK_API_KEY is not configured. Set it in .env to accept iOS Shortcut requests.',
    );
    return null;
  }

  const app = createWebhookApp(bot);
  const port = Number(config.PORT);

  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info(`Webhook server listening on port ${info.port}`);
  });

  return server;
}
