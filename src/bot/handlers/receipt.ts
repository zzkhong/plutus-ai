/**
 * A receipt outside /split: read it and log it as one expense, with the usual
 * Change category / Undo buttons. Logged straight away rather than after a
 * confirmation step, like every other expense. A receipt sent as a photo also
 * gets Split this, which turns the expense into a /split of the same photo.
 */

import { budgetAlertFor } from '../../budget/alerts';
import { logExpense } from '../../expense/service';
import { readReceipt, ReceiptExpense, ReceiptReadError } from '../../expense/receipt';
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
  "I couldn't read a receipt total in SGD, MYR or USD from that photo. Try a clearer, flatter shot, or just type the expense.";

export interface ReceiptOptions {
  caption?: string;
  /** The Telegram file_id of the photo; offers Split this when set. */
  photoFileId?: string;
  now?: Date;
}

/** Logs a receipt that has already been read. */
export async function logReceipt(userId: string, receipt: ReceiptExpense, options: ReceiptOptions = {}): Promise<BotReply> {
  const now = options.now ?? new Date();
  const transaction = await logExpense(userId, {
    amount: receipt.total,
    currency: receipt.currency,
    merchant: receipt.merchant ?? undefined,
    note: options.caption?.trim() || undefined,
    source: 'receipt',
    categoryHint: receipt.category ?? undefined,
    spentAt: earlierDay(receipt.date, now, MAX_RECEIPT_AGE_DAYS),
    photoFileId: options.photoFileId,
  });

  const alert = await budgetAlertFor(userId, transaction);
  const text = [
    `Logged ${formatExpenseLine(transaction, now)} from your receipt.`,
    alert,
    options.photoFileId ? 'Shared bill? Tap Split this, or say "split this".' : 'Shared bill? Tap Undo, then say "split a bill".',
  ]
    .filter(Boolean)
    .join('\n\n');

  return { text, keyboard: transactionActions(transaction.id, 'c', Boolean(options.photoFileId)) };
}

/** Reads a receipt and logs it; anything unreadable logs nothing and says so. */
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
    logger.warn('Could not read a receipt', { message: error.message });
    return { text: NOT_A_RECEIPT_REPLY };
  }
  return logReceipt(userId, receipt, { caption, now });
}
