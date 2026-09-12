/**
 * Telegram bot: middleware and handler registration, shared by both runtime
 * modes.
 *
 * createBot() returns a fully wired grammy Bot without starting anything. On
 * Vercel, the /api/telegram webhook feeds it updates (see
 * src/webhook/routes/telegram.ts); the standalone process calls
 * startPolling() instead.
 *
 * Registration order matters: grammy runs handlers in the order they are
 * added, and the message:text handler consumes every text message without
 * calling next() — so every bot.command(...) must be registered above it.
 *
 * Replies about an expense carry Change category / Undo buttons; presses
 * arrive as callback queries (handlers/callback.ts). On a webhook they only
 * arrive if it was registered with 'callback_query' in allowed_updates — see
 * src/scripts/telegram-webhook.ts.
 */

import { Bot, InputFile } from 'grammy';
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
import { handleWebhookKeyCommand } from './commands/webhookkey';
import { handleRecentCommand } from './commands/recent';
import { handleReviewCommand } from './commands/review';
import { handleTextMessage } from './handlers/text';
import { handleVoiceMessage } from './handlers/voice';
import { handleDocumentMessage } from './handlers/document';
import { handleReceiptPhoto } from './handlers/receipt';
import { CallbackOutcome, handleCallback } from './handlers/callback';
import { handleSplitCommand, handleCancelCommand, handleSplitPhoto, handleSplitTextMessage } from './commands/split';
import { getSplitState } from '../split/state';
import { transactionIdFromMarkup } from './keyboards';
import { BotReply } from './types';

async function downloadTelegramFile(bot: Bot<BotContext>, fileId: string): Promise<Buffer> {
  const file = await bot.api.getFile(fileId);
  const response = await fetch(`https://api.telegram.org/file/bot${bot.token}/${file.file_path}`);
  if (!response.ok) {
    throw new Error(`Telegram file download failed with HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function sendReply(ctx: BotContext, reply: BotReply): Promise<void> {
  await ctx.reply(reply.text, reply.keyboard ? { reply_markup: reply.keyboard } : undefined);
}

/** Applies a button press's outcome to the message the button is on. */
async function applyCallbackOutcome(ctx: BotContext, outcome: CallbackOutcome): Promise<void> {
  await ctx.answerCallbackQuery(outcome.toast ? { text: outcome.toast } : undefined);
  try {
    if (outcome.text !== undefined) {
      // Editing the text without a reply_markup also removes the buttons.
      await ctx.editMessageText(outcome.text, outcome.keyboard ? { reply_markup: outcome.keyboard } : undefined);
    } else if (outcome.keyboard !== undefined) {
      await ctx.editMessageReplyMarkup(outcome.keyboard ? { reply_markup: outcome.keyboard } : undefined);
    }
  } catch (error) {
    // Telegram refuses an edit that changes nothing ("message is not
    // modified"), which a double tap produces. The press was still handled.
    logger.debug('Could not edit the message after a button press', error);
  }
}

export function createBot(token: string | undefined = config.TELEGRAM_BOT_TOKEN): Bot<BotContext> {
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  }

  const bot = new Bot<BotContext>(token);

  bot.use(authMiddleware);
  bot.use(errorHandlerMiddleware);

  bot.command('setup', async (ctx) => {
    await ctx.reply(await handleSetupCommand(String(ctx.chat.id)));
  });

  bot.command('approve', async (ctx) => {
    if (!ctx.user) return;
    const targetChatId = ctx.match?.toString().trim() ?? '';
    const result = await handleApproveCommand(ctx.user, targetChatId);
    await ctx.reply(result.reply);
    if (result.notifyChatId && result.notifyMessage) {
      try {
        await bot.api.sendMessage(result.notifyChatId, result.notifyMessage);
      } catch (error) {
        logger.error('Failed to notify user of approval decision', error);
      }
    }
  });

  bot.command('reject', async (ctx) => {
    if (!ctx.user) return;
    const targetChatId = ctx.match?.toString().trim() ?? '';
    const result = await handleRejectCommand(ctx.user, targetChatId);
    await ctx.reply(result.reply);
    if (result.notifyChatId && result.notifyMessage) {
      try {
        await bot.api.sendMessage(result.notifyChatId, result.notifyMessage);
      } catch (error) {
        logger.error('Failed to notify user of rejection decision', error);
      }
    }
  });

  bot.command('portfolio', async (ctx) => {
    if (!ctx.user) return;
    await ctx.reply(await handlePortfolioCommand(ctx.user.id));
  });

  bot.command('today', async (ctx) => {
    if (!ctx.user) return;
    await ctx.reply(await handleTodayCommand(ctx.user.id));
  });

  bot.command('month', async (ctx) => {
    if (!ctx.user) return;
    await ctx.reply(await handleMonthCommand(ctx.user.id));
  });

  bot.command('budget', async (ctx) => {
    if (!ctx.user) return;
    await ctx.reply(await handleBudgetCommand(ctx.user.id));
  });

  bot.command('export', async (ctx) => {
    if (!ctx.user) return;
    const csv = await handleExportCommand(ctx.user.id);
    if (csv.rowCount === 0) {
      await ctx.reply(`Nothing to export yet — no transactions logged in ${csv.year}.`);
      return;
    }
    await ctx.replyWithDocument(new InputFile(Buffer.from(csv.content, 'utf8'), csv.filename), {
      caption: `${csv.rowCount} transaction${csv.rowCount === 1 ? '' : 's'} from ${csv.year}.`,
    });
  });

  bot.command('undo', async (ctx) => {
    if (!ctx.user) return;
    await ctx.reply(await handleUndoCommand(ctx.user.id));
  });

  bot.command('recent', async (ctx) => {
    if (!ctx.user) return;
    await sendReply(ctx, await handleRecentCommand(ctx.user.id));
  });

  bot.command('review', async (ctx) => {
    if (!ctx.user) return;
    await ctx.reply(await handleReviewCommand(ctx.user.id));
  });

  bot.command('digest', async (ctx) => {
    if (!ctx.user) return;
    await ctx.reply(await handleDigestCommand(ctx.user.id));
  });

  bot.command('split', async (ctx) => {
    if (!ctx.user) return;
    await ctx.reply(await handleSplitCommand(ctx.chat.id));
  });

  bot.command('cancel', async (ctx) => {
    await ctx.reply(await handleCancelCommand(ctx.chat.id));
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(await handleHelpCommand());
  });

  bot.command('webhookkey', async (ctx) => {
    if (!ctx.user) return;
    await ctx.reply(await handleWebhookKeyCommand(ctx.user));
  });

  bot.command('start', async (ctx) => {
    await ctx.reply(formatHelpMessage());
  });

  bot.on('message:text', async (ctx) => {
    if (!ctx.user) {
      return; // authMiddleware already replied for unregistered/pending chats
    }

    if (ctx.user.status === 'onboarding') {
      const wasEnteringApiKey = Boolean(ctx.user.llm_provider);
      const result = await handleSetupTextMessage(ctx.user, ctx.message.text);
      await ctx.reply(result.reply);

      if (wasEnteringApiKey) {
        await ctx.deleteMessage().catch(() => {
          // best-effort — Telegram may refuse if the bot lacks delete rights
        });
      }

      if (result.notifyAdminForChatId && config.ADMIN_CHAT_ID) {
        try {
          await bot.api.sendMessage(
            config.ADMIN_CHAT_ID,
            `New signup pending approval: chat_id ${result.notifyAdminForChatId}. Use /approve ${result.notifyAdminForChatId} or /reject ${result.notifyAdminForChatId}.`,
          );
        } catch (error) {
          logger.error('Failed to notify admin of new signup', error);
        }
      }
      return;
    }

    if (await getSplitState(ctx.chat.id)) {
      await ctx.reply(await handleSplitTextMessage(ctx.chat.id, ctx.user.id, ctx.message.text));
      return;
    }

    // A reply to an expense's confirmation corrects that expense.
    const targetTransactionId = transactionIdFromMarkup(ctx.message.reply_to_message?.reply_markup);
    await sendReply(ctx, await handleTextMessage(ctx.user.id, ctx.message.text, targetTransactionId));
  });

  bot.on('message:voice', async (ctx) => {
    if (!ctx.user) return;
    const voice = ctx.message.voice;
    const buffer = await downloadTelegramFile(bot, voice.file_id);
    const targetTransactionId = transactionIdFromMarkup(ctx.message.reply_to_message?.reply_markup);
    await sendReply(
      ctx,
      await handleVoiceMessage(ctx.chat.id, ctx.user.id, buffer, voice.mime_type ?? 'audio/ogg', targetTransactionId),
    );
  });

  bot.on('message:document', async (ctx) => {
    if (!ctx.user) return;
    const document = ctx.message.document;
    const buffer = await downloadTelegramFile(bot, document.file_id);
    await ctx.reply(await handleDocumentMessage(ctx.user.id, buffer, document.mime_type ?? '', document.file_name));
  });

  bot.on('message:photo', async (ctx) => {
    if (!ctx.user) return;
    const photos = ctx.message.photo;
    if (photos.length === 0) {
      return;
    }
    const largest = photos[photos.length - 1];
    const buffer = await downloadTelegramFile(bot, largest.file_id);
    // A photo belongs to an in-progress /split; any other photo is a receipt to log.
    if (await getSplitState(ctx.chat.id)) {
      await ctx.reply(await handleSplitPhoto(ctx.chat.id, ctx.user.id, buffer, 'image/jpeg'));
      return;
    }
    await sendReply(ctx, await handleReceiptPhoto(ctx.user.id, buffer, 'image/jpeg', ctx.message.caption));
  });

  bot.on('callback_query:data', async (ctx) => {
    if (!ctx.user) {
      await ctx.answerCallbackQuery();
      return;
    }
    await applyCallbackOutcome(ctx, await handleCallback(ctx.user.id, ctx.callbackQuery.data));
  });

  return bot;
}

/**
 * Long polling, for the standalone process (local development or a
 * self-hosted server). grammy's start() deletes any registered webhook
 * first — pointed at a production bot token, that would silently cut the
 * Vercel deployment off from Telegram. So this refuses while a webhook is
 * set.
 */
export async function startPolling(bot: Bot<BotContext>): Promise<void> {
  const webhook = await bot.api.getWebhookInfo();
  if (webhook.url) {
    throw new Error(
      `This bot token has a webhook registered (${webhook.url}), so another deployment is receiving its messages. ` +
        'Starting long polling would delete that webhook. Use a separate bot token for local development, ' +
        'or run `npm run telegram:webhook -- delete` first if you mean to take this bot over.',
    );
  }

  logger.info('Starting Telegram bot (long polling)');
  await bot.start({
    drop_pending_updates: true,
    onStart: () => logger.info('Telegram bot started (long polling)'),
  });
}
