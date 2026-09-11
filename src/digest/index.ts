/**
 * Daily digest scheduler, manual trigger, and message builder.
 */

import * as cron from 'node-cron';
import { Bot } from 'grammy';
import { config } from '../config';
import { listApproved } from '../users/service';
import { logger } from '../utils/logger';
import { collectDigestData } from './aggregator';
import { formatDigestMessage } from './formatter';
import { generateSummaryLine } from './summary';

let schedulerTask: cron.ScheduledTask | null = null;

export async function buildDigestMessage(userId: string): Promise<string> {
  const data = await collectDigestData(userId);
  const summaryLine = await generateSummaryLine(userId, data);
  return formatDigestMessage(data, summaryLine);
}

/**
 * Builds and delivers the digest once per approved user, each on their own
 * telegram_chat_id. One user's failure is logged and never blocks the rest
 * of the run — same convention as the recurring-transaction cron.
 */
export async function triggerDigestNow(bot: Bot | null): Promise<void> {
  if (!bot) {
    logger.warn('Skipping digest delivery: no bot instance available');
    return;
  }

  const users = await listApproved();

  for (const user of users) {
    try {
      logger.info(`Building daily digest for user ${user.id}`);
      const message = await buildDigestMessage(user.id);
      await bot.api.sendMessage(user.telegram_chat_id, message);
      logger.info(`Daily digest sent to user ${user.id}`);
    } catch (error) {
      logger.error(`Failed to send daily digest to user ${user.id}`, error);
    }
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
    { timezone: config.APP_TIMEZONE },
  );

  logger.info(`Daily digest scheduler started (runs daily at 22:00 ${config.APP_TIMEZONE})`);
}

export function stopDigestScheduler(): void {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
    logger.info('Daily digest scheduler stopped');
  }
}
