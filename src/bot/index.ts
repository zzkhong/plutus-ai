/**
 * Telegram bot initialization and command routing
 */

import { Bot, Context } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { authMiddleware } from './middleware/auth';
import { errorHandlerMiddleware } from './middleware/error';
import { formatHelpMessage } from './formatter/messages';
import { handlePortfolioCommand } from './commands/portfolio';
import { handleTodayCommand } from './commands/today';
import { handleMonthCommand } from './commands/month';
import { handleBudgetCommand } from './commands/budget';
import { handleExportCommand } from './commands/export';
import { handleUndoCommand } from './commands/undo';
import { handleHelpCommand } from './commands/help';
import { handleTextMessage } from './handlers/text';
import { handleVoiceMessage } from './handlers/voice';

export class PlutoBot {
  private bot: Bot;

  constructor() {
    if (!config.TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }

    this.bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  }

  private async replyWithText(ctx: Context, text: string): Promise<void> {
    await ctx.reply(text, { parse_mode: 'Markdown' });
  }

  public async start(): Promise<void> {
    logger.info('Starting Telegram bot');

    this.bot.use(async (ctx, next) => {
      await authMiddleware(ctx, next);
    });

    this.bot.use(async (ctx, next) => {
      await errorHandlerMiddleware(ctx, next);
    });

    this.bot.command('portfolio', async (ctx) => {
      const response = await handlePortfolioCommand();
      await this.replyWithText(ctx, response);
    });

    this.bot.command('today', async (ctx) => {
      const response = await handleTodayCommand();
      await this.replyWithText(ctx, response);
    });

    this.bot.command('month', async (ctx) => {
      const response = await handleMonthCommand();
      await this.replyWithText(ctx, response);
    });

    this.bot.command('budget', async (ctx) => {
      const response = await handleBudgetCommand();
      await this.replyWithText(ctx, response);
    });

    this.bot.command('export', async (ctx) => {
      const response = await handleExportCommand();
      await this.replyWithText(ctx, response);
    });

    this.bot.command('undo', async (ctx) => {
      const response = await handleUndoCommand();
      await this.replyWithText(ctx, response);
    });

    this.bot.command('help', async (ctx) => {
      const response = await handleHelpCommand();
      await this.replyWithText(ctx, response);
    });

    this.bot.on('message:text', async (ctx) => {
      const response = await handleTextMessage(ctx.message.text);
      await this.replyWithText(ctx, response);
    });

    this.bot.on('message:voice', async (ctx) => {
      const voice = ctx.message.voice;
      if (!voice) {
        return;
      }
      const response = await handleVoiceMessage(String(voice.file_id));
      await this.replyWithText(ctx, response);
    });

    this.bot.command('start', async (ctx) => {
      await this.replyWithText(ctx, formatHelpMessage());
    });

    await this.bot.start({
      drop_pending_updates: true,
    });

    logger.info('Telegram bot started successfully');
  }

  public async stop(): Promise<void> {
    logger.info('Stopping Telegram bot');
    await this.bot.stop();
  }

  public getBot(): Bot {
    return this.bot;
  }
}

export const bot = new PlutoBot();
