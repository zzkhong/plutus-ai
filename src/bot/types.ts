/**
 * Telegram bot related types and interfaces
 */

export type BotIntent =
  | 'expense'
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
