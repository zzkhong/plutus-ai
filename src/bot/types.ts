/**
 * Telegram bot related types and interfaces
 */

import type { InlineKeyboard } from 'grammy';

export type BotIntent =
  | 'expense'
  | 'income'
  | 'query'
  | 'budget'
  | 'correction'
  | 'recurring'
  | 'holdings'
  | 'help'
  | 'unknown';

export type CommandName =
  | 'portfolio'
  | 'today'
  | 'month'
  | 'budget'
  | 'export'
  | 'undo'
  | 'help';

export interface BotCommandResponse {
  command: CommandName;
  text: string;
}

/** A reply to send, with buttons under it when there's something to act on. */
export interface BotReply {
  text: string;
  keyboard?: InlineKeyboard;
}
