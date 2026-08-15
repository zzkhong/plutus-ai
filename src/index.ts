/**
 * Plutus AI - Personal Finance AI Assistant
 * Entry point for the application
 */

import { logger } from './utils/logger';
import { config } from './config';
import { db } from './db';

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

    // TODO: Initialize bot, scheduler, and HTTP server
    logger.info('Placeholder: Bot, Scheduler, and HTTP server initialization pending...');
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
