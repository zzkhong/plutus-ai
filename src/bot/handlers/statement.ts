/**
 * Importing a brokerage statement, shared by files (document.ts) and photos
 * (photo.ts). The two try the readers in opposite orders — a file is usually
 * a statement, a photo usually a receipt — but import the same way.
 */

import { logger } from '../../utils/logger';
import { formatDay } from '../../utils/dates';
import { NotAStatementError, parseStatement, StatementFileKind, StatementParseError } from '../../portfolio/statement-parser';
import { replaceHoldingsForBroker } from '../../portfolio/service';
import { getPortfolioSummary } from '../../portfolio';
import { formatCurrency } from '../../config';
import { BotReply } from '../types';

/**
 * Reads the file as a statement and replaces that broker's holdings with it.
 * Throws NotAStatementError when the model says it isn't a statement, so the
 * caller can try it as a receipt; any other read failure is answered here.
 */
export async function importStatement(
  userId: string,
  data: Buffer,
  kind: StatementFileKind,
  mimeType: string,
): Promise<BotReply> {
  let statement;
  try {
    statement = await parseStatement(userId, { data, kind, mimeType });
  } catch (error) {
    if (error instanceof StatementParseError && !(error instanceof NotAStatementError)) {
      logger.warn('Statement parse failed', { message: error.message });
      return {
        text: `I couldn't read that statement: ${error.message}. Try sending it again, or another export of it such as a PDF.`,
      };
    }
    throw error;
  }

  const imported = await replaceHoldingsForBroker(userId, statement.broker, statement.holdings, statement.as_of);
  const summary = await getPortfolioSummary(userId);

  const count = `${imported.length} position${imported.length === 1 ? '' : 's'}`;
  const lines = [
    `Updated your ${statement.broker.toUpperCase()} holdings: ${count} at the statement's prices from ${formatDay(statement.as_of)}.`,
    `New net worth: ${formatCurrency(summary.net_worth_sgd, 'SGD')}.`,
  ];
  if (statement.skipped.length > 0) {
    const skipped = statement.skipped.map((s) => `${s.symbol} (${s.reason})`).join(', ');
    lines.push(`Skipped ${statement.skipped.length} I can't value yet: ${skipped}.`);
  }
  return { text: lines.join('\n') };
}
