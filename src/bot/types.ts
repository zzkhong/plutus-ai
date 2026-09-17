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
  | 'find'
  | 'export'
  | 'portfolio'
  | 'digest'
  | 'review'
  | 'undo'
  | 'split'
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
  /** A file to send, with `text` as its caption — an export asked for in chat or by voice. */
  document?: { filename: string; content: string };
}
