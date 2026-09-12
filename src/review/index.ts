/**
 * The month-end review. On the 1st, every approved user gets last month in
 * numbers — spend against the month before, where it went, income and
 * savings rate, and which budgets held. /review shows it on demand.
 *
 * Deterministic, with no LLM call: it's a report, and it shouldn't cost a
 * user's free-tier quota on the 1st.
 */

import * as cron from 'node-cron';
import { Bot } from 'grammy';
import { config } from '../config';
import { listApproved } from '../users/service';
import { startOfMonth } from '../utils/dates';
import { logger } from '../utils/logger';
import { collectMonthReview } from './aggregator';
import { formatMonthReview } from './formatter';

export { collectMonthReview } from './aggregator';
export { formatMonthReview } from './formatter';
export type { MonthReviewData } from './types';

let schedulerTask: cron.ScheduledTask | null = null;

/** The review of the month before `now`'s, or null when nothing was logged in it. */
export async function buildMonthReview(userId: string, now: Date = new Date()): Promise<string | null> {
  const data = await collectMonthReview(userId, startOfMonth(now, -1));
  if (data.count === 0 && data.incomeSgd === 0) {
    return null;
  }
  return formatMonthReview(data);
}

/**
 * Sends each approved user last month's review on their own chat, skipping
 * anyone with nothing logged. One user's failure is logged and never blocks
 * the rest — same convention as the other scheduled jobs.
 */
export async function triggerMonthReviewNow(bot: Bot | null): Promise<void> {
  if (!bot) {
    logger.warn('Skipping month review delivery: no bot instance available');
    return;
  }

  for (const user of await listApproved()) {
    try {
      const review = await buildMonthReview(user.id);
      if (review) {
        await bot.api.sendMessage(user.telegram_chat_id, review);
        logger.info(`Month review sent to user ${user.id}`);
      }
    } catch (error) {
      logger.error(`Failed to send month review to user ${user.id}`, error);
    }
  }
}

/** 09:00 on the 1st, in APP_TIMEZONE — for the standalone process. */
export function startReviewScheduler(bot: Bot | null): void {
  if (schedulerTask) {
    logger.warn('Month review scheduler already running, skipping start');
    return;
  }

  schedulerTask = cron.schedule(
    '0 9 1 * *',
    async () => {
      logger.info('Running month review scheduler');
      try {
        await triggerMonthReviewNow(bot);
      } catch (error) {
        logger.error('Failed to run month review', error);
      }
    },
    { timezone: config.APP_TIMEZONE },
  );

  logger.info(`Month review scheduler started (runs at 09:00 on the 1st, ${config.APP_TIMEZONE})`);
}

export function stopReviewScheduler(): void {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
    logger.info('Month review scheduler stopped');
  }
}
