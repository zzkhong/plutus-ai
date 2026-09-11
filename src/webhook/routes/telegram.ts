/**
 * POST /api/telegram — Telegram's webhook delivery, used on Vercel.
 *
 * Every request must carry the X-Telegram-Bot-Api-Secret-Token header that
 * was registered with setWebhook. Without that check, anyone who learned the
 * URL could post a forged update claiming to come from the admin's chat and
 * /approve themselves.
 *
 * The update is acknowledged immediately and processed through waitUntil.
 * Replies that call Gemini (voice notes, PDFs, receipt photos) can take
 * 15-30s; holding Telegram's request open that long risks it timing out and
 * redelivering the update, which would log the same expense twice.
 */

import { Context } from 'hono';
import { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { waitUntil as vercelWaitUntil } from '@vercel/functions';
import { logger } from '../../utils/logger';
import { safeEqual } from '../../utils/secure-compare';

export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/** The slice of a grammy Bot this route uses — lets tests pass a fake. */
export type UpdateProcessor = Pick<Bot, 'init' | 'isInited' | 'handleUpdate'>;

export interface TelegramWebhookOptions {
  secret: string | undefined;
  /** Keeps the function alive until background work settles. Defaults to Vercel's; a no-op elsewhere. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export function createTelegramWebhookHandler(bot: UpdateProcessor | null, options: TelegramWebhookOptions) {
  let initializing: Promise<void> | null = null;

  // One getMe per function instance, not per update. A failed attempt is
  // forgotten so the next update retries instead of failing forever.
  const ensureInitialized = (processor: UpdateProcessor): Promise<void> => {
    if (processor.isInited()) {
      return Promise.resolve();
    }
    initializing ??= processor.init().catch((error) => {
      initializing = null;
      throw error;
    });
    return initializing;
  };

  return async (c: Context): Promise<Response> => {
    if (!bot) {
      return c.json({ status: 'error', message: 'Telegram bot is not configured' }, 503);
    }

    if (!options.secret) {
      logger.error('Rejecting Telegram update: TELEGRAM_WEBHOOK_SECRET is not configured');
      return c.json({ status: 'error', message: 'Webhook secret is not configured' }, 503);
    }

    if (!safeEqual(c.req.header(TELEGRAM_SECRET_HEADER), options.secret)) {
      return c.json({ status: 'error', message: 'Unauthorized' }, 401);
    }

    let update: Update;
    try {
      update = await c.req.json();
    } catch {
      return c.json({ status: 'error', message: 'Invalid JSON payload' }, 400);
    }

    // Initialize before acknowledging: if getMe fails, a 500 makes Telegram
    // retry the update later instead of it being silently dropped.
    try {
      await ensureInitialized(bot);
    } catch (error) {
      logger.error('Telegram bot initialization failed', error);
      return c.json({ status: 'error', message: 'Bot initialization failed' }, 500);
    }

    const processing = bot.handleUpdate(update).catch((error) => {
      logger.error(`Failed to process Telegram update ${update.update_id}`, error);
    });
    (options.waitUntil ?? vercelWaitUntil)(processing);

    return c.json({ ok: true });
  };
}
