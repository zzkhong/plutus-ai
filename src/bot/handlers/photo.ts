/**
 * A photo outside /split. Usually a receipt, sometimes a screenshot of a
 * brokerage or portfolio screen — people don't know to send those as files.
 *
 * The order is the reverse of document.ts on purpose: a file is usually a
 * statement, so it's read as one first; a photo is usually a receipt. Either
 * way the common case is one vision call, and only a photo the receipt reader
 * says isn't a receipt at all (NotAReceiptError) is tried as a statement. A
 * receipt that's merely hard to read must never import holdings.
 */

import { NotAReceiptError, readReceipt, ReceiptReadError } from '../../expense/receipt';
import { NotAStatementError } from '../../portfolio/statement-parser';
import { logger } from '../../utils/logger';
import { BotReply } from '../types';
import { logReceipt, NOT_A_RECEIPT_REPLY, ReceiptOptions } from './receipt';
import { importStatement } from './statement';

export const NOT_A_RECEIPT_OR_STATEMENT_REPLY =
  "That doesn't look like a receipt or a brokerage statement I can read. Send receipts as a clear photo, and statements as a screenshot, PDF or CSV.";

export async function handlePhotoMessage(
  userId: string,
  photo: Buffer,
  mimeType: string,
  options: ReceiptOptions = {},
): Promise<BotReply> {
  try {
    return await logReceipt(userId, await readReceipt(userId, photo, mimeType), options);
  } catch (error) {
    if (!(error instanceof ReceiptReadError)) {
      throw error;
    }
    if (!(error instanceof NotAReceiptError)) {
      logger.warn('Could not read a receipt photo', { message: error.message });
      return { text: NOT_A_RECEIPT_REPLY };
    }
  }

  try {
    return await importStatement(userId, photo, 'image', mimeType);
  } catch (error) {
    if (error instanceof NotAStatementError) {
      return { text: NOT_A_RECEIPT_OR_STATEMENT_REPLY };
    }
    throw error;
  }
}
