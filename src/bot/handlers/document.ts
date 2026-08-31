/**
 * Statement PDF upload handling for the Telegram bot.
 */

import { logger } from '../../utils/logger';
import { parseStatement, StatementParseError } from '../../portfolio/statement-parser';
import { replaceHoldingsForBroker } from '../../portfolio/service';
import { getPortfolioSummary } from '../../portfolio';
import { formatCurrency } from '../../config';

export async function handleDocumentMessage(fileBuffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType !== 'application/pdf') {
    return "I can only read PDF statements right now — please upload your IBKR or Moomoo statement as a PDF.";
  }

  let parsed;
  try {
    parsed = await parseStatement(fileBuffer);
  } catch (error) {
    if (error instanceof StatementParseError) {
      logger.warn('Statement parse failed', { message: error.message });
      return `I couldn't read that statement (${error.message}). Try re-uploading, or check it's an IBKR/Moomoo statement PDF.`;
    }
    throw error;
  }

  const updated = await replaceHoldingsForBroker(parsed.broker, parsed.holdings);
  const summary = await getPortfolioSummary();

  return `Updated ${parsed.broker.toUpperCase()} holdings — ${updated.length} position(s). New net worth: ${formatCurrency(summary.net_worth_sgd, 'SGD')}.`;
}
