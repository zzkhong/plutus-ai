/**
 * Single-user access guard for Telegram messages
 */

import { config } from '../../config';

export async function authMiddleware(ctx: any, next: any): Promise<void> {
  const authorizedChatId = config.TELEGRAM_AUTHORIZED_CHAT_ID;

  if (!authorizedChatId) {
    await next();
    return;
  }

  const chatId = ctx.chat?.id;
  if (chatId === undefined || String(chatId) !== String(authorizedChatId)) {
    await ctx.reply(
      'Hey, this bot is locked to one user only. I can\'t take requests from this chat right now.',
    );
    return;
  }

  await next();
}
