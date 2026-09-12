/**
 * A photo sent outside /split: read it as a receipt and log it as one
 * expense, with the usual Change category / Undo buttons. Logged straight
 * away rather than after a confirmation step, like every other expense —
 * Undo is one tap if it was meant for /split.
 */

import { budgetAlertFor } from '../../budget/alerts';
import { logExpense } from '../../expense/service';
import { readReceipt, ReceiptReadError } from '../../expense/receipt';
import { earlierDay } from '../../utils/dates';
import { logger } from '../../utils/logger';
import { formatExpenseLine } from '../formatter/messages';
import { transactionActions } from '../keyboards';
import { BotReply } from '../types';

/**
 * A receipt date further back than this is taken as a misread — filed under
 * the year it claims, the expense would land somewhere nobody looks.
 */
const MAX_RECEIPT_AGE_DAYS = 90;

export const NOT_A_RECEIPT_REPLY =
  "I couldn't read a receipt total in SGD, MYR or USD from that photo. Try a clearer, flatter shot, or just type the expense. " +
  'To split a bill, send /split first; to import a brokerage statement, send it as a file.';

export async function handleReceiptPhoto(
  userId: string,
  photo: Buffer,
  mimeType: string,
  caption?: string,
  now: Date = new Date(),
): Promise<BotReply> {
  let receipt;
  try {
    receipt = await readReceipt(userId, photo, mimeType);
  } catch (error) {
    if (!(error instanceof ReceiptReadError)) {
      throw error;
    }
    logger.warn('Could not read a receipt photo', { message: error.message });
    return { text: NOT_A_RECEIPT_REPLY };
  }

  const transaction = await logExpense(userId, {
    amount: receipt.total,
    currency: receipt.currency,
    merchant: receipt.merchant ?? undefined,
    note: caption?.trim() || undefined,
    source: 'receipt',
    categoryHint: receipt.category ?? undefined,
    spentAt: earlierDay(receipt.date, now, MAX_RECEIPT_AGE_DAYS),
  });

  const alert = await budgetAlertFor(userId, transaction);
  const text = [
    `Logged ${formatExpenseLine(transaction, now)} from your receipt.`,
    alert,
    'Meant to split it? Tap Undo, then send /split.',
  ]
    .filter(Boolean)
    .join('\n\n');

  return { text, keyboard: transactionActions(transaction.id) };
}
