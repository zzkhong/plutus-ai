/**
 * The HTTP app. One Hono app serves every inbound request in both runtime
 * modes:
 *
 * - On Vercel, src/app.ts default-exports it and Vercel turns it into a
 *   function: Telegram pushes updates to /api/telegram, Vercel Cron calls
 *   /api/cron/*, and the iOS Shortcut posts to /api/apple-pay.
 * - In the standalone process (src/standalone.ts), startWebhookServer serves
 *   it on config.PORT. Telegram updates arrive by long polling there and
 *   node-cron runs the jobs, so only /api/apple-pay and /api/health are used.
 */

import { serve, ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { Bot } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { triggerDigestNow } from '../digest';
import { triggerMonthReviewNow } from '../review';
import { triggerRecurringNow } from '../scheduler/recurring';
import { apiKeyAuthMiddleware } from './auth';
import { createApplePayHandler } from './routes/apple-pay';
import { createCronHandler } from './routes/cron';
import { createTelegramWebhookHandler, UpdateProcessor } from './routes/telegram';
import { WebhookEnv } from './types';

export type CronJobs = Record<'recurring' | 'digest' | 'review', () => Promise<void>>;

/** Overrides for tests; production code passes none and gets config values. */
export interface WebhookAppOptions {
  telegramSecret?: string;
  cronSecret?: string;
  telegram?: UpdateProcessor | null;
  waitUntil?: (promise: Promise<unknown>) => void;
  jobs?: Partial<CronJobs>;
}

export function createWebhookApp(bot: Bot | null, options: WebhookAppOptions = {}): Hono<WebhookEnv> {
  const app = new Hono<WebhookEnv>();

  // `in` rather than `??`, so a test can pass an explicit undefined secret.
  const telegramSecret = 'telegramSecret' in options ? options.telegramSecret : config.TELEGRAM_WEBHOOK_SECRET;
  const cronSecret = 'cronSecret' in options ? options.cronSecret : config.CRON_SECRET;
  const telegram = 'telegram' in options ? (options.telegram ?? null) : bot;
  const jobs: CronJobs = {
    recurring: () => triggerRecurringNow(bot),
    digest: () => triggerDigestNow(bot),
    review: () => triggerMonthReviewNow(bot),
    ...options.jobs,
  };

  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.post('/api/apple-pay', apiKeyAuthMiddleware, createApplePayHandler(bot));
  app.post(
    '/api/telegram',
    createTelegramWebhookHandler(telegram, { secret: telegramSecret, waitUntil: options.waitUntil }),
  );
  app.get('/api/cron/recurring', createCronHandler('recurring', jobs.recurring, { secret: cronSecret }));
  app.get('/api/cron/digest', createCronHandler('digest', jobs.digest, { secret: cronSecret }));
  app.get('/api/cron/review', createCronHandler('review', jobs.review, { secret: cronSecret }));

  return app;
}

export function startWebhookServer(bot: Bot | null): ServerType | null {
  // No global secret gate — each approved user authenticates with their own
  // users.webhook_api_key, so the server is always safe to start.
  const app = createWebhookApp(bot);
  const port = Number(config.PORT);

  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info(`HTTP server listening on port ${info.port}`);
  });

  return server;
}
