/**
 * /recent — the last 10 expenses as buttons. Opening one offers Change
 * category and Delete, and replying to it corrects that expense — the way
 * to fix something that isn't the latest.
 */

import { formatCurrency } from '../../config/currencies';
import { listRecentTransactions } from '../../expense/service';
import { formatShortDay } from '../../utils/dates';
import { recentList } from '../keyboards';
import { BotReply } from '../types';

const RECENT_LIMIT = 10;
const LABEL_MERCHANT_LENGTH = 22;

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export async function handleRecentCommand(userId: string): Promise<BotReply> {
  const recent = await listRecentTransactions(userId, RECENT_LIMIT);
  if (recent.length === 0) {
    return { text: 'Nothing logged yet. Try "Spent $4.50 at Ya Kun".' };
  }

  return {
    text: `Your last ${recent.length === 1 ? 'expense' : `${recent.length} expenses`}, newest first. Tap one to change or delete it.`,
    keyboard: recentList(
      recent.map((transaction) => ({
        id: transaction.id,
        label: `${formatShortDay(transaction.spent_at)} · ${formatCurrency(transaction.amount_sgd, 'SGD')} · ${truncate(transaction.merchant, LABEL_MERCHANT_LENGTH)}`,
      })),
    ),
  };
}
