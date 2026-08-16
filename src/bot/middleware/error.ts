/**
 * Global Telegram error handling middleware
 */

import { logger } from '../../utils/logger';
import { formatUserFriendlyError } from '../formatter/messages';

export async function errorHandlerMiddleware(ctx: any, next: any): Promise<void> {
  try {
    await next();
  } catch (error) {
    logger.error('Telegram bot request failed', error);
    await ctx.reply(formatUserFriendlyError());
  }
}
