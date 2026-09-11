/**
 * Recurring transactions scheduler
 * Automatically logs recurring transactions on their scheduled day, once
 * per approved user, then checks each one against that user's budget alert
 * thresholds.
 */

import * as cron from 'node-cron';
import { Api, Bot } from 'grammy';
import { config } from '../config';
import { fireRecurringForToday } from '../expense/service';
import { checkAlerts } from '../budget/alerts';
import { listApproved } from '../users/service';
import { Transaction } from '../types';
import { logger } from '../utils/logger';

let schedulerTask: cron.ScheduledTask | null = null;

/**
 * Check each newly created transaction against its category budget and push
 * a Telegram message for any newly crossed threshold, for one user.
 */
export async function deliverBudgetAlerts(
  api: Api | null,
  telegramChatId: string,
  userId: string,
  transactions: Transaction[],
): Promise<void> {
  if (transactions.length === 0) {
    return;
  }

  if (!api) {
    logger.warn('Skipping budget alert delivery: no bot instance available');
    return;
  }

  for (const transaction of transactions) {
    const alert = await checkAlerts(userId, transaction);
    if (alert) {
      try {
        await api.sendMessage(telegramChatId, alert.message);
      } catch (error) {
        logger.error('Failed to deliver budget alert', error);
      }
    }
  }
}

/**
 * Fires due recurring entries for every approved user. One user's failure
 * (a thrown error anywhere in their own processing) is caught and logged
 * without blocking the rest of the run.
 */
async function fireForAllApprovedUsers(bot: Bot | null): Promise<void> {
  const users = await listApproved();

  for (const user of users) {
    try {
      const created = await fireRecurringForToday(user.id);
      if (created.length > 0) {
        logger.info(`Created ${created.length} recurring transaction(s) for user ${user.id}`, {
          transactions: created.map((t) => ({ merchant: t.merchant, amount: t.amount, category: t.category })),
        });
        await deliverBudgetAlerts(bot?.api ?? null, user.telegram_chat_id, user.id, created);
      } else {
        logger.debug(`No recurring transactions due today for user ${user.id}`);
      }
    } catch (error) {
      logger.error(`Failed to process recurring transactions for user ${user.id}`, error);
    }
  }
}

/**
 * Start the recurring transactions scheduler.
 * Runs daily at midnight (00:00) to check and log any recurring transactions
 * due today, for every approved user. `bot` is used to push budget alerts —
 * pass null if the Telegram bot isn't running.
 */
export function startRecurringScheduler(bot: Bot | null): void {
  if (schedulerTask) {
    logger.warn('Recurring scheduler already running, skipping start');
    return;
  }

  schedulerTask = cron.schedule(
    '0 0 * * *',
    async () => {
      logger.info('Running recurring transactions scheduler');
      await fireForAllApprovedUsers(bot);
    },
    { timezone: config.APP_TIMEZONE },
  );

  logger.info(`Recurring transactions scheduler started (runs daily at 00:00 ${config.APP_TIMEZONE})`);
}

/**
 * Stop the recurring transactions scheduler
 */
export function stopRecurringScheduler(): void {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
    logger.info('Recurring transactions scheduler stopped');
  }
}

/**
 * Manually trigger recurring transactions for every approved user (useful
 * for testing or startup recovery).
 */
export async function triggerRecurringNow(bot: Bot | null): Promise<void> {
  logger.info('Manually triggering recurring transactions');
  await fireForAllApprovedUsers(bot);
}
