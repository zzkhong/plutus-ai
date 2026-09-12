/**
 * Inline keyboards and the callback data behind their buttons.
 *
 * Telegram caps callback data at 64 bytes, so it's terse:
 *
 *   t:c:<ctx>:<id>        show the category picker for transaction <id>
 *   t:s:<ctx>:<id>:<cat>  file transaction <id> under <cat>
 *   t:d:<ctx>:<id>        delete transaction <id>
 *   t:b:<ctx>:<id>        back from the picker to the actions
 *   t:v:<id>              open transaction <id> from the /recent list
 *   r:l                   the /recent list
 *   i:d:<id>              delete income <id>
 *   h:g:<SYMBOL>:<rank>   price chat-entered coin <SYMBOL> as the CoinGecko
 *                         coin at market-cap rank <rank>
 *   h:n:<SYMBOL>          leave <SYMBOL> unpriced
 *   rc:d:<id>             remove recurring charge <id>
 *
 * <ctx> is where the buttons sit: 'c' under a confirmation, 'r' in /recent,
 * which adds a way back to the list. The longest, "t:s:r:" + a UUID +
 * ":Entertainment", is 56 bytes.
 *
 * Callback data comes back from the client, so it is untrusted: every
 * handler scopes the id to the user who pressed the button.
 */

import { InlineKeyboard } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { matchCategory, VALID_CATEGORIES } from '../expense/categorizer';
import { Category } from '../types';

export type ButtonContext = 'c' | 'r';

export type CallbackAction =
  | { kind: 'pick-category'; ctx: ButtonContext; transactionId: string }
  | { kind: 'set-category'; ctx: ButtonContext; transactionId: string; category: Category }
  | { kind: 'delete'; ctx: ButtonContext; transactionId: string }
  | { kind: 'back'; ctx: ButtonContext; transactionId: string }
  | { kind: 'view'; transactionId: string }
  | { kind: 'recent' }
  | { kind: 'delete-income'; incomeId: string }
  | { kind: 'pick-coin'; symbol: string; rank: number }
  | { kind: 'skip-coin'; symbol: string }
  | { kind: 'remove-recurring'; recurringId: string };

const ID = /^[0-9a-f-]{36}$/i;
const SYMBOL = /^[A-Z0-9]{1,15}$/;

function isContext(value: string): value is ButtonContext {
  return value === 'c' || value === 'r';
}

/** The action a button's callback data asks for, or null for anything malformed or stale. */
export function parseCallbackData(data: string): CallbackAction | null {
  const parts = data.split(':');

  if (data === 'r:l') {
    return { kind: 'recent' };
  }
  if (parts[0] === 'rc' && parts[1] === 'd' && parts.length === 3 && ID.test(parts[2])) {
    return { kind: 'remove-recurring', recurringId: parts[2] };
  }
  if (parts[0] === 'i' && parts[1] === 'd' && parts.length === 3 && ID.test(parts[2])) {
    return { kind: 'delete-income', incomeId: parts[2] };
  }
  if (parts[0] === 'h' && SYMBOL.test(parts[2] ?? '')) {
    if (parts[1] === 'g' && parts.length === 4 && /^\d{1,6}$/.test(parts[3])) {
      return { kind: 'pick-coin', symbol: parts[2], rank: Number(parts[3]) };
    }
    if (parts[1] === 'n' && parts.length === 3) {
      return { kind: 'skip-coin', symbol: parts[2] };
    }
    return null;
  }
  if (parts[0] !== 't') {
    return null;
  }
  if (parts[1] === 'v' && parts.length === 3 && ID.test(parts[2])) {
    return { kind: 'view', transactionId: parts[2] };
  }

  const [, verb, ctx, transactionId, argument] = parts;
  if (!isContext(ctx) || !transactionId || !ID.test(transactionId)) {
    return null;
  }
  switch (verb) {
    case 'c':
      return parts.length === 4 ? { kind: 'pick-category', ctx, transactionId } : null;
    case 'd':
      return parts.length === 4 ? { kind: 'delete', ctx, transactionId } : null;
    case 'b':
      return parts.length === 4 ? { kind: 'back', ctx, transactionId } : null;
    case 's': {
      const category = parts.length === 5 ? matchCategory(argument) : null;
      return category ? { kind: 'set-category', ctx, transactionId, category } : null;
    }
    default:
      return null;
  }
}

/** Change category / Undo — under every expense confirmation, and in /recent. */
export function transactionActions(transactionId: string, ctx: ButtonContext = 'c'): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text('Change category', `t:c:${ctx}:${transactionId}`)
    .text(ctx === 'c' ? 'Undo' : 'Delete', `t:d:${ctx}:${transactionId}`);
  if (ctx === 'r') {
    keyboard.row().text('« All recent', 'r:l');
  }
  return keyboard;
}

export function categoryPicker(transactionId: string, ctx: ButtonContext, current?: Category): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  VALID_CATEGORIES.forEach((category, index) => {
    keyboard.text(category === current ? `• ${category}` : category, `t:s:${ctx}:${transactionId}:${category}`);
    if (index % 3 === 2) {
      keyboard.row();
    }
  });
  return keyboard.row().text('« Back', `t:b:${ctx}:${transactionId}`);
}

/** One button per transaction, each opening it. */
export function recentList(entries: Array<{ id: string; label: string }>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const entry of entries) {
    keyboard.text(entry.label, `t:v:${entry.id}`).row();
  }
  return keyboard;
}

/** A Remove button for each recurring charge, for /recurring. */
export function recurringList(charges: Array<{ id: string; merchant: string }>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const charge of charges) {
    const name = charge.merchant.length > 28 ? `${charge.merchant.slice(0, 27)}…` : charge.merchant;
    keyboard.text(`Remove ${name}`, `rc:d:${charge.id}`).row();
  }
  return keyboard;
}

export function backToRecent(): InlineKeyboard {
  return new InlineKeyboard().text('« All recent', 'r:l');
}

/** One button per CoinGecko match for a coin outside the built-in table, and a way to leave it unpriced. */
export function coinPicker(symbol: string, candidates: Array<{ name: string; rank: number }>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const coin of candidates) {
    keyboard.text(`${coin.name} · #${coin.rank}`, `h:g:${symbol}:${coin.rank}`).row();
  }
  return keyboard.text('None of these', `h:n:${symbol}`);
}

export function incomeActions(incomeId: string): InlineKeyboard {
  return new InlineKeyboard().text('Undo', `i:d:${incomeId}`);
}

/**
 * The transaction a message's buttons act on. Replying to a confirmation (or
 * a /recent entry) with "it was $12" corrects that transaction rather than
 * the latest one: the replied-to message comes with its keyboard, so the id
 * is right there and nothing has to be remembered between messages.
 */
export function transactionIdFromMarkup(markup: InlineKeyboardMarkup | undefined): string | null {
  for (const row of markup?.inline_keyboard ?? []) {
    for (const button of row) {
      const action = 'callback_data' in button && button.callback_data ? parseCallbackData(button.callback_data) : null;
      if (action && 'transactionId' in action) {
        return action.transactionId;
      }
    }
  }
  return null;
}
