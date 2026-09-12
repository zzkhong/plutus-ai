/**
 * Resolves the calling chat's users row and gates access by status.
 *
 * - Unregistered and pending-approval chats can only reach /setup and /help.
 * - A chat part-way through /setup can also send the text replies the setup
 *   conversation asks for, but nothing else yet: without an API key there's
 *   nothing to read a photo, voice note or file with, and no account for a
 *   command or button to act on.
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

  const isSetupReply = text !== undefined && !text.startsWith('/');
  if (user.status === 'onboarding' && !isSetupOrHelp && !isSetupReply) {
    await ctx.reply(
      user.llm_provider
        ? 'Finish setting up first: send me your Gemini API key, or /setup to start again.'
        : 'Finish setting up first: reply "gemini" to pick your provider, or /setup to start again.',
    );
    return;
  }

  ctx.user = user;
  await next();
}
