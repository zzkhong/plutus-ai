/**
 * Recurring transactions scheduler
 * Automatically logs recurring transactions on their scheduled day
 */

import * as cron from 'node-cron';
import { fireRecurringForToday } from '../expense/service';
import { logger } from '../utils/logger';

let schedulerTask: cron.ScheduledTask | null = null;

/**
 * Start the recurring transactions scheduler
 * Runs daily at midnight (00:00) to check and log any recurring transactions due today
 */
export function startRecurringScheduler(): void {
  if (schedulerTask) {
    logger.warn('Recurring scheduler already running, skipping start');
    return;
  }

  // Run at midnight every day (00:00)
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
export async function triggerRecurringNow(): Promise<void> {
  logger.info('Manually triggering recurring transactions');
  try {
    const created = await fireRecurringForToday();
    logger.info(`Manually created ${created.length} recurring transaction(s)`);
  } catch (error) {
    logger.error('Failed to manually trigger recurring transactions', error);
    throw error;
  }
}
