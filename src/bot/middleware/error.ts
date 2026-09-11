/**
 * Global Telegram error handling middleware
 */

import { NextFunction } from 'grammy';
import { logger } from '../../utils/logger';
import { formatUserFriendlyError } from '../formatter/messages';
import { BotContext } from '../context';

export async function errorHandlerMiddleware(ctx: BotContext, next: NextFunction): Promise<void> {
  try {
    await next();
  } catch (error) {
    logger.error('Telegram bot request failed', error);
    await ctx.reply(formatUserFriendlyError());
  }
}
