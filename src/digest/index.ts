/**
 * Daily digest scheduler, manual trigger, and message builder.
 */

import * as cron from 'node-cron';
import { Bot } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { collectDigestData } from './aggregator';
import { formatDigestMessage } from './formatter';
import { generateSummaryLine } from './summary';

let schedulerTask: cron.ScheduledTask | null = null;

export async function buildDigestMessage(): Promise<string> {
  const data = await collectDigestData();
  const summaryLine = await generateSummaryLine(data);
  return formatDigestMessage(data, summaryLine);
}

export async function triggerDigestNow(bot: Bot | null): Promise<void> {
  logger.info('Building daily digest');
  const message = await buildDigestMessage();

  if (!bot) {
    logger.warn('Skipping digest delivery: no bot instance available');
    return;
  }

  if (!config.TELEGRAM_AUTHORIZED_CHAT_ID) {
    logger.warn('Skipping digest delivery: TELEGRAM_AUTHORIZED_CHAT_ID is not configured');
    return;
  }

  try {
    await bot.api.sendMessage(config.TELEGRAM_AUTHORIZED_CHAT_ID, message);
    logger.info('Daily digest sent');
  } catch (error) {
    logger.error('Failed to send daily digest', error);
  }
}

export function startDigestScheduler(bot: Bot | null): void {
  if (schedulerTask) {
    logger.warn('Digest scheduler already running, skipping start');
    return;
  }

  schedulerTask = cron.schedule(
    '0 22 * * *',
    async () => {
      logger.info('Running daily digest scheduler');
      try {
        await triggerDigestNow(bot);
      } catch (error) {
        logger.error('Failed to run daily digest', error);
      }
    },
    { timezone: 'Asia/Singapore' },
  );

  logger.info('Daily digest scheduler started (runs daily at 22:00 Asia/Singapore)');
}

export function stopDigestScheduler(): void {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
    logger.info('Daily digest scheduler stopped');
  }
}
