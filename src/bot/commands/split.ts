/**
 * /split flow orchestration: receipt photo -> even/itemized split ->
 * optional logging of the requester's own share only. See
 * docs/tasks/08-expense-split.md.
 */

import { logger } from '../../utils/logger';
import { logExpense } from '../../expense';
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

export function handleSplitCommand(chatId: number): string {
  startSplit(chatId);
  return 'Send me a photo of the receipt to split, or /cancel to stop.';
}

export function handleCancelCommand(chatId: number): string {
  return clearSplit(chatId) ? 'Split cancelled.' : 'Nothing to cancel.';
}

export async function handleSplitPhoto(
  chatId: number,
  userId: string,
  photoBuffer: Buffer,
  mimeType: string,
): Promise<string> {
  const state = getSplitState(chatId);
  if (!state || state.stage !== 'awaiting_photo') {
    return 'Got a photo — if you want to split a bill, run /split first.';
  }

  try {
    const receipt = await extractReceipt(userId, photoBuffer, mimeType);
    setReceipt(chatId, receipt);
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
  const state = getSplitState(chatId);
  if (!state) {
    throw new Error(`handleSplitTextMessage called with no active split for chat ${chatId}`);
  }

  if (state.stage === 'awaiting_photo') {
    return 'Still waiting on a photo of the receipt — send one, or /cancel to stop.';
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

      setPendingResult(chatId, result);
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
    const confirmed = /^\s*y(es)?\s*$/i.test(message);
    const declined = /^\s*no?\s*$/i.test(message);

    if (!confirmed && !declined) {
      return 'Reply Yes to log your share, or No to skip.';
    }

    const pendingResult = state.pendingResult;
    if (!pendingResult || !pendingResult.requesterShare) {
      throw new Error(`Split for chat ${chatId} is awaiting_log_confirmation with no pending result`);
    }
    const receipt = state.receipt;

    if (declined) {
      clearSplit(chatId);
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

    clearSplit(chatId);

    return `Logged ${formatCurrency(transaction.amount_sgd, 'SGD')} for ${transaction.merchant} (${transaction.category}).`;
  }

  throw new Error(`Unexpected split stage "${state.stage}" for chat ${chatId}`);
}
