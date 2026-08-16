/**
 * /help command handler
 */

import { formatHelpMessage } from '../formatter/messages';

export async function handleHelpCommand(): Promise<string> {
  return formatHelpMessage();
}
