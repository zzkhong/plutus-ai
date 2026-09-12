/**
 * Standalone entrypoint: one long-running Node process, for local
 * development (`npm run dev`) or a self-hosted server (`npm run start`).
 *
 * Unlike the Vercel deployment (src/app.ts), this process owns everything
 * itself: it migrates the database on boot, long-polls Telegram, runs the
 * scheduled jobs with node-cron, and serves the HTTP app on config.PORT.
 */

import { logger } from './utils/logger';
import { config } from './config';
import { runMigrations } from './db/migrate';
import { createBot, startPolling } from './bot';
import { startRecurringScheduler, triggerRecurringNow } from './scheduler/recurring';
import { startDigestScheduler } from './digest';
import { startReviewScheduler } from './review';
import { startWebhookServer } from './webhook';

async function main(): Promise<void> {
  logger.info('Starting Plutus AI (standalone)...');
  logger.info(`Environment: ${config.NODE_ENV} | Timezone: ${config.APP_TIMEZONE} | Log level: ${config.LOG_LEVEL}`);
  logger.info(`Database: ${config.DATABASE_URL}`);

  await runMigrations();
  logger.info('Database ready');

  const bot = config.TELEGRAM_BOT_TOKEN ? createBot() : null;
  if (bot) {
    // Not awaited: grammy's polling loop only resolves when the bot stops.
    startPolling(bot).catch((error) => {
      logger.error('Telegram bot failed to start', error);
    });
  } else {
    logger.warn('Telegram bot not started because TELEGRAM_BOT_TOKEN is not configured');
  }

  startRecurringScheduler(bot);
  startDigestScheduler(bot);
  startReviewScheduler(bot);
  startWebhookServer(bot);

  // Catch up on recurring charges if the process was down at midnight. Safe
  // to repeat: fireRecurringForToday skips charges already logged today.
  await triggerRecurringNow(bot);
  logger.info('Plutus AI is ready');
}

main().catch((error) => {
  logger.error('Failed to start Plutus AI', error);
  process.exit(1);
});
