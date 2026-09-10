/**
 * Telegram bot initialization and command routing
 */

import { Bot } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { BotContext } from './context';
import { authMiddleware } from './middleware/auth';
import { errorHandlerMiddleware } from './middleware/error';
import { formatHelpMessage } from './formatter/messages';
import { handlePortfolioCommand } from './commands/portfolio';
import { handleTodayCommand } from './commands/today';
import { handleMonthCommand } from './commands/month';
import { handleBudgetCommand } from './commands/budget';
import { handleExportCommand } from './commands/export';
import { handleUndoCommand } from './commands/undo';
import { handleDigestCommand } from './commands/digest';
import { handleHelpCommand } from './commands/help';
import { handleSetupCommand, handleSetupTextMessage } from './commands/setup';
import { handleApproveCommand, handleRejectCommand } from './commands/approve';
import { handleTextMessage } from './handlers/text';
import { handleVoiceMessage } from './handlers/voice';
import { handleDocumentMessage } from './handlers/document';
import { handleSplitCommand, handleCancelCommand, handleSplitPhoto, handleSplitTextMessage } from './commands/split';
import { getSplitState } from '../split/state';

export class PlutoBot {
  private bot: Bot<BotContext>;

  constructor() {
    if (!config.TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }

    this.bot = new Bot<BotContext>(config.TELEGRAM_BOT_TOKEN);
  }

  private async replyWithText(ctx: BotContext, text: string): Promise<void> {
    await ctx.reply(text);
  }

  public async start(): Promise<void> {
    logger.info('Starting Telegram bot');

    this.bot.use(async (ctx, next) => {
      await authMiddleware(ctx, next);
    });

    this.bot.use(async (ctx, next) => {
      await errorHandlerMiddleware(ctx, next);
    });

    this.bot.command('setup', async (ctx) => {
      const reply = await handleSetupCommand(String(ctx.chat.id));
      await this.replyWithText(ctx, reply);
    });

    this.bot.command('approve', async (ctx) => {
      if (!ctx.user) return;
      const targetChatId = ctx.match?.toString().trim() ?? '';
      const result = await handleApproveCommand(ctx.user, targetChatId);
      await this.replyWithText(ctx, result.reply);
      if (result.notifyChatId && result.notifyMessage) {
        try {
          await this.bot.api.sendMessage(result.notifyChatId, result.notifyMessage);
        } catch (error) {
          logger.error('Failed to notify user of approval decision', error);
        }
      }
    });

    this.bot.command('reject', async (ctx) => {
      if (!ctx.user) return;
      const targetChatId = ctx.match?.toString().trim() ?? '';
      const result = await handleRejectCommand(ctx.user, targetChatId);
      await this.replyWithText(ctx, result.reply);
      if (result.notifyChatId && result.notifyMessage) {
        try {
          await this.bot.api.sendMessage(result.notifyChatId, result.notifyMessage);
        } catch (error) {
          logger.error('Failed to notify user of rejection decision', error);
        }
      }
    });

    this.bot.command('portfolio', async (ctx) => {
      if (!ctx.user) return;
      const response = await handlePortfolioCommand(ctx.user.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('today', async (ctx) => {
      if (!ctx.user) return;
      const response = await handleTodayCommand(ctx.user.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('month', async (ctx) => {
      if (!ctx.user) return;
      const response = await handleMonthCommand(ctx.user.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('budget', async (ctx) => {
      if (!ctx.user) return;
      const response = await handleBudgetCommand(ctx.user.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('export', async (ctx) => {
      if (!ctx.user) return;
      const response = await handleExportCommand(ctx.user.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('undo', async (ctx) => {
      if (!ctx.user) return;
      const response = await handleUndoCommand(ctx.user.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('digest', async (ctx) => {
      if (!ctx.user) return;
      const response = await handleDigestCommand(ctx.user.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('split', async (ctx) => {
      if (!ctx.user) return;
      const response = handleSplitCommand(ctx.chat.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('cancel', async (ctx) => {
      const response = handleCancelCommand(ctx.chat.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('help', async (ctx) => {
      const response = await handleHelpCommand();
      await this.replyWithText(ctx, response);
    });

    this.bot.on('message:text', async (ctx) => {
      if (!ctx.user) {
        return; // authMiddleware already replied for unregistered/pending chats
      }

      if (ctx.user.status === 'onboarding') {
        const wasEnteringApiKey = Boolean(ctx.user.llm_provider);
        const result = await handleSetupTextMessage(ctx.user, ctx.message.text);
        await this.replyWithText(ctx, result.reply);

        if (wasEnteringApiKey) {
          await ctx.deleteMessage().catch(() => {
            // best-effort — Telegram may refuse if the bot lacks delete rights
          });
        }

        if (result.notifyAdminForChatId && config.ADMIN_CHAT_ID) {
          try {
            await this.bot.api.sendMessage(
              config.ADMIN_CHAT_ID,
              `New signup pending approval: chat_id ${result.notifyAdminForChatId}. Use /approve ${result.notifyAdminForChatId} or /reject ${result.notifyAdminForChatId}.`,
            );
          } catch (error) {
            logger.error('Failed to notify admin of new signup', error);
          }
        }
        return;
      }

      if (getSplitState(ctx.chat.id)) {
        const response = await handleSplitTextMessage(ctx.chat.id, ctx.user.id, ctx.message.text);
        await this.replyWithText(ctx, response);
        return;
      }

      const response = await handleTextMessage(ctx.user.id, ctx.message.text);
      await this.replyWithText(ctx, response);
    });

    this.bot.on('message:voice', async (ctx) => {
      if (!ctx.user) return;
      const voice = ctx.message.voice;
      if (!voice) {
        return;
      }
      const file = await ctx.api.getFile(voice.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      const reply = await handleVoiceMessage(ctx.chat.id, ctx.user.id, buffer, voice.mime_type ?? 'audio/ogg');
      await this.replyWithText(ctx, reply);
    });

    this.bot.on('message:document', async (ctx) => {
      if (!ctx.user) return;
      const document = ctx.message.document;
      if (!document) {
        return;
      }
      const file = await ctx.api.getFile(document.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      const reply = await handleDocumentMessage(ctx.user.id, buffer, document.mime_type ?? '');
      await this.replyWithText(ctx, reply);
    });

    this.bot.on('message:photo', async (ctx) => {
      if (!ctx.user) return;
      const photos = ctx.message.photo;
      if (!photos || photos.length === 0) {
        return;
      }
      const largest = photos[photos.length - 1];
      const file = await ctx.api.getFile(largest.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      const reply = await handleSplitPhoto(ctx.chat.id, ctx.user.id, buffer, 'image/jpeg');
      await this.replyWithText(ctx, reply);
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

  public getBot(): Bot<BotContext> {
    return this.bot;
  }
}

export const bot = new PlutoBot();
