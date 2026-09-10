/**
 * Resolves the calling chat's users row and gates access by status.
 * Unregistered and pending-approval chats can only reach /setup and /help.
 */

import { NextFunction } from 'grammy';
import { findByChatId } from '../../users/service';
import { BotContext } from '../context';

export async function authMiddleware(ctx: BotContext, next: NextFunction): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    await next();
    return;
  }

  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : undefined;
  const isSetupOrHelp = Boolean(text && /^\/(setup|help)(\s|$)/.test(text));

  const user = await findByChatId(String(chatId));

  if (!user || user.status === 'pending_approval') {
    if (isSetupOrHelp) {
      if (user) {
        ctx.user = user;
      }
      await next();
      return;
    }
    await ctx.reply(user ? 'Still waiting on admin approval — hang tight!' : 'Run /setup to get started.');
    return;
  }

  ctx.user = user;
  await next();
}
