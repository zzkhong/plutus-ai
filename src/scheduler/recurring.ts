/**
 * Recurring transactions scheduler
 * Automatically logs recurring transactions on their scheduled day,
 * then checks each one against budget alert thresholds.
 */

import * as cron from 'node-cron';
import { Api, Bot } from 'grammy';
import { fireRecurringForToday } from '../expense/service';
import { checkAlerts } from '../budget/alerts';
import { Transaction } from '../types';
import { config } from '../config';
import { logger } from '../utils/logger';

let schedulerTask: cron.ScheduledTask | null = null;

/**
 * Check each newly created transaction against its category budget and
 * push a Telegram message for any newly crossed threshold.
 */
export async function deliverBudgetAlerts(api: Api | null, transactions: Transaction[]): Promise<void> {
  if (transactions.length === 0) {
    return;
  }

  if (!api) {
    logger.warn('Skipping budget alert delivery: no bot instance available');
    return;
  }

  if (!config.TELEGRAM_AUTHORIZED_CHAT_ID) {
    logger.warn('Skipping budget alert delivery: TELEGRAM_AUTHORIZED_CHAT_ID is not configured');
    return;
  }

  for (const transaction of transactions) {
    const alert = await checkAlerts(transaction);
    if (alert) {
      await api.sendMessage(config.TELEGRAM_AUTHORIZED_CHAT_ID, alert.message);
    }
  }
}

/**
 * Start the recurring transactions scheduler.
 * Runs daily at midnight (00:00) to check and log any recurring transactions due today.
 * `bot` is used to push budget alerts for any transaction it creates — pass null
 * if the Telegram bot isn't running (alerts are then skipped, with a log warning).
 */
export function startRecurringScheduler(bot: Bot | null): void {
  if (schedulerTask) {
    logger.warn('Recurring scheduler already running, skipping start');
    return;
  }

  schedulerTask = cron.schedule('0 0 * * *', async () => {
    logger.info('Running recurring transactions scheduler');
    try {
      const created = await fireRecurringForToday();
      if (created.length > 0) {
        logger.info(`Created ${created.length} recurring transaction(s)`, {
          transactions: created.map((t) => ({
            merchant: t.merchant,
            amount: t.amount,
            category: t.category,
          })),
        });
        await deliverBudgetAlerts(bot?.api ?? null, created);
      } else {
        logger.debug('No recurring transactions due today');
      }
    } catch (error) {
      logger.error('Failed to process recurring transactions', error);
    }
  });

  logger.info('Recurring transactions scheduler started (runs daily at 00:00)');
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
 * Manually trigger recurring transactions (useful for testing or startup recovery)
 */
export async function triggerRecurringNow(bot: Bot | null): Promise<void> {
  logger.info('Manually triggering recurring transactions');
  try {
    const created = await fireRecurringForToday();
    logger.info(`Manually created ${created.length} recurring transaction(s)`);
    await deliverBudgetAlerts(bot?.api ?? null, created);
  } catch (error) {
    logger.error('Failed to manually trigger recurring transactions', error);
    throw error;
  }
}
