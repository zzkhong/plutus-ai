/**
 * /split flow orchestration: receipt photo -> even/itemized split ->
 * optional logging of the requester's own share only.
 */

import { logger } from '../../utils/logger';
import { deleteTransaction, getTransaction, logExpense } from '../../expense';
import { budgetAlertFor } from '../../budget/alerts';
import { extractReceipt, ExtractionError } from '../../split/extraction';
import { parseSplitInstructions, AssignmentParseError } from '../../split/assignment';
import { calculateEvenSplit, calculateItemizedSplit } from '../../split/calculator';
import { clearSplit, getSplitState, setPendingResult, setReceipt, startSplit } from '../../split/state';
import { formatCurrency } from '../../config';
import { Currency } from '../../types';
import { PersonShare, SplitResult } from '../../split/types';

function formatBreakdown(result: SplitResult, currency: Currency): string {
  return result.shares
    .map((share: PersonShare) => `${share.label}: ${formatCurrency(Math.round(share.total * 100), currency)}`)
    .join('\n');
}

/**
 * The answers to "Log your share?" and a request to stop. These only ever
 * run inside an active split, where the question asked is known, so they are
 * matched directly rather than classified.
 */
const YES_REPLY = /^\s*(y|yes|yeah|yep|yup|sure|ok|okay|please|yes please|log it|do it)\s*[.!]*\s*$/i;
const NO_REPLY = /^\s*(n|no|nope|nah|skip|no thanks|don'?t)\s*[.!]*\s*$/i;
const CANCEL_REPLY = /^\s*(cancel|stop|never ?mind|forget it)\b/i;

export type FileDownloader = (fileId: string) => Promise<Buffer>;

export async function handleSplitCommand(chatId: number): Promise<string> {
  await startSplit(chatId);
  return 'Send me a photo of the receipt to split, or say "cancel" to stop.';
}

/**
 * Turns an expense logged from a receipt photo into a /split of that photo:
 * fetches the photo again, reads its line items, opens the split, and only
 * then removes the single expense — a receipt that can't be itemized keeps
 * its expense. The user's share is logged when the split finishes.
 */
export async function splitLoggedReceipt(
  chatId: number,
  userId: string,
  transactionId: string,
  downloadFile: FileDownloader,
): Promise<string> {
  const transaction = await getTransaction(userId, transactionId);
  if (!transaction) {
    return 'That expense has already been deleted.';
  }
  if (!transaction.photo_file_id) {
    return `That expense wasn't read from a receipt photo, so there's nothing to split. Say "split a bill" and send the photo.`;
  }

  let receipt;
  try {
    const photo = await downloadFile(transaction.photo_file_id);
    receipt = await extractReceipt(userId, photo, 'image/jpeg');
  } catch (error) {
    if (error instanceof ExtractionError) {
      logger.warn('Receipt extraction for a logged receipt failed', { message: error.message });
      return `I couldn't read the items on that receipt (${error.message}), so I've kept the expense as it is.`;
    }
    logger.error('Could not fetch a logged receipt photo', error);
    return "I couldn't fetch that receipt photo from Telegram, so I've kept the expense. Say \"split a bill\" and send it again.";
  }

  await startSplit(chatId);
  await setReceipt(chatId, receipt);
  await deleteTransaction(userId, transaction.id);

  const items = `${receipt.items.length} item${receipt.items.length === 1 ? '' : 's'}`;
  return [
    `Removed the ${formatCurrency(transaction.amount_sgd, 'SGD')} expense at ${transaction.merchant} — I'll log your share instead.`,
    `Got it${receipt.merchant ? ` — ${receipt.merchant}` : ''}, ${items}. Should I split it evenly, or tell me who had what?`,
  ].join('\n\n');
}

export async function handleCancelCommand(chatId: number): Promise<string> {
  return (await clearSplit(chatId)) ? 'Split cancelled.' : 'Nothing to cancel.';
}

export async function handleSplitPhoto(
  chatId: number,
  userId: string,
  photoBuffer: Buffer,
  mimeType: string,
): Promise<string> {
  const state = await getSplitState(chatId);
  if (!state || state.stage !== 'awaiting_photo') {
    return 'Got a photo — to split a bill, run /split first. To import a brokerage statement screenshot, send it as a file instead.';
  }

  try {
    const receipt = await extractReceipt(userId, photoBuffer, mimeType);
    await setReceipt(chatId, receipt);
    return `Got it${receipt.merchant ? ` — ${receipt.merchant}` : ''}. Should I split it evenly, or tell me who had what?`;
  } catch (error) {
    if (error instanceof ExtractionError) {
      logger.warn('Receipt extraction failed', { message: error.message });
      return `I couldn't read that receipt (${error.message}). Try a clearer photo.`;
    }
    throw error;
  }
}

export async function handleSplitTextMessage(chatId: number, userId: string, message: string): Promise<string> {
  const state = await getSplitState(chatId);
  if (!state) {
    throw new Error(`handleSplitTextMessage called with no active split for chat ${chatId}`);
  }

  // A split captures every message, so saying "cancel" has to work as well as /cancel.
  if (CANCEL_REPLY.test(message)) {
    await clearSplit(chatId);
    return 'Split cancelled.';
  }

  if (state.stage === 'awaiting_photo') {
    return 'Still waiting on a photo of the receipt — send one, or say "cancel" to stop.';
  }

  if (state.stage === 'awaiting_instructions') {
    if (!state.receipt) {
      throw new Error(`Split for chat ${chatId} is awaiting_instructions with no receipt`);
    }
    const receipt = state.receipt;

    try {
      const instructions = await parseSplitInstructions(userId, message, receipt.items);
      const result =
        instructions.mode === 'even'
          ? calculateEvenSplit(receipt.total, instructions.headcount!)
          : calculateItemizedSplit(
              receipt.items,
              receipt.taxAndTip,
              instructions.itemAssignments!,
              instructions.requesterLabel,
            );

      if (!result.requesterShare) {
        return 'I couldn\'t tell which share is yours — mention yourself as "I" or "me" and try again.';
      }

      await setPendingResult(chatId, result);
      const breakdown = formatBreakdown(result, receipt.currency);
      const shareCents = Math.round(result.requesterShare.total * 100);
      return `${breakdown}\n\nLog your share of ${formatCurrency(
        shareCents,
        receipt.currency,
      )} as an expense? (skip if it's already logged some other way, e.g. Apple Pay) Yes/No`;
    } catch (error) {
      if (error instanceof AssignmentParseError) {
        logger.warn('Split instruction parsing failed', { message: error.message });
        return `I couldn't work that out (${error.message}). Try again — e.g. "split between 3" or "Alice had the burger, I had the salad".`;
      }
      throw error;
    }
  }

  if (state.stage === 'awaiting_log_confirmation') {
    const confirmed = YES_REPLY.test(message);
    const declined = NO_REPLY.test(message);

    if (!confirmed && !declined) {
      return 'Reply Yes to log your share, or No to skip.';
    }

    const pendingResult = state.pendingResult;
    if (!pendingResult || !pendingResult.requesterShare) {
      throw new Error(`Split for chat ${chatId} is awaiting_log_confirmation with no pending result`);
    }
    const receipt = state.receipt;

    if (declined) {
      await clearSplit(chatId);
      return 'Okay, nothing logged.';
    }

    const merchant = receipt?.merchant ?? 'Split bill';
    const transaction = await logExpense(userId, {
      amount: pendingResult.requesterShare.total,
      currency: receipt?.currency,
      merchant,
      note: 'Split bill',
      source: 'split',
    });

    await clearSplit(chatId);

    const reply = `Logged ${formatCurrency(transaction.amount_sgd, 'SGD')} for ${transaction.merchant} (${transaction.category}).`;
    const alert = await budgetAlertFor(userId, transaction);
    return alert ? `${reply}\n\n${alert}` : reply;
  }

  throw new Error(`Unexpected split stage "${state.stage}" for chat ${chatId}`);
}
