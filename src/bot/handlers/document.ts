/**
 * Files: statement import, from any broker and any file the statement reader
 * can handle — a PDF, a screenshot sent as a file, or a CSV/text export. The
 * positions replace that broker's previous holdings, valued at the
 * statement's prices.
 *
 * A PDF or image that the statement reader says isn't a statement is then
 * read as a receipt, so an e-receipt PDF or a receipt photo sent as a file is
 * logged too. Only that answer triggers it: a statement that's merely hard to
 * read must never turn into an expense.
 */

import { NotAStatementError, StatementFileKind } from '../../portfolio/statement-parser';
import { BotReply } from '../types';
import { handleReceiptPhoto } from './receipt';
import { importStatement } from './statement';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);
const TEXT_TYPES = new Set(['application/csv', 'text/comma-separated-values']);
const TEXT_EXTENSIONS = /\.(csv|tsv|txt)$/i;

/**
 * Which kind of file this is, or null if the statement reader can't handle
 * it. The file name matters because Telegram often reports a CSV saved on
 * Windows as application/vnd.ms-excel, and a PDF as application/octet-stream.
 */
export function statementFileKind(mimeType: string, fileName = ''): StatementFileKind | null {
  const mime = mimeType.toLowerCase();
  if (mime === 'application/pdf' || /\.pdf$/i.test(fileName)) {
    return 'pdf';
  }
  if (IMAGE_TYPES.has(mime)) {
    return 'image';
  }
  if (mime.startsWith('text/') || TEXT_TYPES.has(mime) || TEXT_EXTENSIONS.test(fileName)) {
    return 'text';
  }
  return null;
}

export async function handleDocumentMessage(
  userId: string,
  fileBuffer: Buffer,
  mimeType: string,
  fileName?: string,
): Promise<BotReply> {
  const kind = statementFileKind(mimeType, fileName);
  if (!kind) {
    return {
      text: "I can read statements sent as a PDF, a screenshot or a CSV export, and receipts as a photo or PDF, and that file isn't one of those. If it's a spreadsheet, export it as PDF or CSV first.",
    };
  }

  const fileMimeType = kind === 'pdf' ? 'application/pdf' : mimeType;
  try {
    return await importStatement(userId, fileBuffer, kind, fileMimeType);
  } catch (error) {
    if (error instanceof NotAStatementError && kind !== 'text') {
      const receipt = await handleReceiptPhoto(userId, fileBuffer, fileMimeType);
      if (receipt.keyboard) {
        return receipt;
      }
      return {
        text: "That doesn't look like a brokerage statement or a receipt I can read. Send statements as a PDF, screenshot or CSV, and receipts as a photo.",
      };
    }
    throw error;
  }
}
