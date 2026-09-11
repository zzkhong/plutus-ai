/**
 * Vercel entrypoint. Vercel's zero-config Hono support finds this file and
 * turns the default-exported app into a Vercel Function. Nothing here starts
 * a process: Telegram pushes updates to /api/telegram, and Vercel Cron calls
 * /api/cron/* on the schedules in vercel.json.
 *
 * Keep this the only candidate entrypoint that imports hono. Vercel looks
 * for app, index and server files at the root and in src/, which is why the
 * long-running process lives in src/standalone.ts instead of src/index.ts.
 *
 * Migrations don't run here — the Vercel build runs them (vercel-build).
 */

import { Hono } from 'hono';
import { config } from './config';
import { createBot } from './bot';
import { createWebhookApp } from './webhook';

const bot = config.TELEGRAM_BOT_TOKEN ? createBot() : null;

const app = new Hono();
app.route('/', createWebhookApp(bot));

export default app;
