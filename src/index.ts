/**
 * Plutus AI - Personal Finance AI Assistant
 * Entry point for the application
 */

import { logger } from './utils/logger';
import { config } from './config';
import { db } from './db';
import { PlutoBot } from './bot';
import { startRecurringScheduler, triggerRecurringNow } from './scheduler/recurring';

/**
 * Initialize application
 */
async function initialize(): Promise<void> {
  logger.info('Starting Plutus AI application...');
  logger.debug('Configuration loaded', { environment: config.NODE_ENV });

  try {
    logger.info('Initializing database...');

    // Importing db triggers the singleton creation, which:
    // 1) creates the data directory if needed
    // 2) opens the SQLite file at ./data/pluto.db
    // 3) runs CREATE TABLE IF NOT EXISTS for all core tables
    // So the app bootstraps its database automatically before continuing.
    logger.info('Database initialized successfully', {
      status: 'connected',
      database: config.DATABASE_URL,
    });

    logger.info('Plutus AI application is ready!');
    logger.info(`Environment: ${config.NODE_ENV}`);
    logger.info(`Database: ${config.DATABASE_URL}`);
    logger.info(`Log Level: ${config.LOG_LEVEL}`);

    let plutoBot: PlutoBot | null = null;
    if (config.TELEGRAM_BOT_TOKEN) {
      plutoBot = new PlutoBot();
      // Do not await: Bot.start() runs grammy's long-polling loop and does not
      // resolve until the bot is stopped. Awaiting it here would block every line
      // below (the recurring scheduler, budget alert delivery) from ever running.
      plutoBot.start().catch((error) => {
        logger.error('Telegram bot failed to start', error);
      });
      logger.info('Telegram bot core initialized');
    } else {
      logger.warn('Telegram bot not started because TELEGRAM_BOT_TOKEN is not configured');
    }

    // Start recurring transactions scheduler
    startRecurringScheduler(plutoBot ? plutoBot.getBot() : null);

    // Check and fire any recurring transactions that may have been missed during downtime
    logger.info('Checking for recurring transactions due today...');
    await triggerRecurringNow(plutoBot ? plutoBot.getBot() : null);

    logger.info('Recurring transactions scheduler running (daily at 00:00)');
  } catch (error) {
    logger.error('Failed to initialize application', error);
    process.exit(1);
  }
}

// Run initialization
initialize().catch((error) => {
  logger.error('Unexpected error during initialization', error);
  process.exit(1);
});
