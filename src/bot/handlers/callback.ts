/**
 * Inline-button presses. Works out what a press should change and returns
 * it as a CallbackOutcome; src/bot/index.ts applies that to the message, so
 * this stays testable without a Telegram context.
 */

import { InlineKeyboard } from 'grammy';
import { budgetAlertFor } from '../../budget/alerts';
import { deleteTransaction, getTransaction, setTransactionCategory } from '../../expense/service';
import { deleteIncome } from '../../income/service';
import { findCoinByRank } from '../../portfolio/price-fetcher/crypto';
import { setCoingeckoId } from '../../portfolio/service';
import { handleRecentCommand } from '../commands/recent';
import { formatExpenseLine, formatMoneyWithSgd, formatTransactionDetail } from '../formatter/messages';
import { backToRecent, categoryPicker, parseCallbackData, transactionActions } from '../keyboards';

export interface CallbackOutcome {
  /** A brief notice at the top of the chat. */
  toast?: string;
  /** Replaces the message's text; undefined leaves it as it is. */
  text?: string;
  /** Replaces the message's buttons; null removes them, undefined leaves them. */
  keyboard?: InlineKeyboard | null;
}

export async function handleCallback(userId: string, data: string): Promise<CallbackOutcome> {
  const action = parseCallbackData(data);
  if (!action) {
    return { toast: "That button doesn't work any more.", keyboard: null };
  }

  if (action.kind === 'recent') {
    const recent = await handleRecentCommand(userId);
    return { text: recent.text, keyboard: recent.keyboard ?? null };
  }

  if (action.kind === 'delete-income') {
    const removed = await deleteIncome(userId, action.incomeId);
    if (!removed) {
      return { toast: 'That income was already removed.', keyboard: null };
    }
    return {
      toast: 'Removed',
      text: `Removed ${formatMoneyWithSgd(removed)} of income from ${removed.source}.`,
      keyboard: null,
    };
  }

  if (action.kind === 'pick-coin') {
    const coin = await findCoinByRank(action.symbol, action.rank);
    if (!coin) {
      return {
        toast: `I couldn't confirm that coin on CoinGecko just now. Try again, or send the holding again for a fresh list.`,
      };
    }
    if ((await setCoingeckoId(userId, action.symbol, coin.id)) === 0) {
      return { toast: `You don't hold ${action.symbol} any more.`, keyboard: null };
    }
    return {
      toast: 'Priced',
      text: `Got it — your ${action.symbol} is ${coin.name}, priced live from CoinGecko. /portfolio includes it now.`,
      keyboard: null,
    };
  }

  if (action.kind === 'skip-coin') {
    return {
      text: `OK — ${action.symbol} stays without a price, so it counts as S$0 in your net worth.`,
      keyboard: null,
    };
  }

  const transaction = await getTransaction(userId, action.transactionId);
  if (!transaction) {
    return { toast: 'That expense has already been deleted.', keyboard: null };
  }

  switch (action.kind) {
    case 'view':
      return { text: formatTransactionDetail(transaction), keyboard: transactionActions(transaction.id, 'r') };
    case 'pick-category':
      return { keyboard: categoryPicker(transaction.id, action.ctx, transaction.category) };
    case 'back':
      return { keyboard: transactionActions(transaction.id, action.ctx) };
    case 'set-category': {
      if (action.category === transaction.category) {
        return { toast: `Already under ${transaction.category}`, keyboard: transactionActions(transaction.id, action.ctx) };
      }
      const updated = (await setTransactionCategory(userId, transaction.id, action.category)) ?? transaction;
      // A new category can take that category's budget over a threshold.
      const alert = await budgetAlertFor(userId, updated);
      const text = action.ctx === 'r' ? formatTransactionDetail(updated) : `Updated: ${formatExpenseLine(updated)}.`;
      return {
        toast: `Moved to ${updated.category}`,
        text: alert ? `${text}\n\n${alert}` : text,
        keyboard: transactionActions(updated.id, action.ctx),
      };
    }
    case 'delete': {
      await deleteTransaction(userId, transaction.id);
      return {
        toast: 'Removed',
        text: `Removed ${formatMoneyWithSgd(transaction)} at ${transaction.merchant}.`,
        keyboard: action.ctx === 'r' ? backToRecent() : null,
      };
    }
  }
}
