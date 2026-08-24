/**
 * /undo command handler
 */

import { undoLastTransaction } from '../../expense';

export async function handleUndoCommand(): Promise<string> {
  const removed = await undoLastTransaction();

  if (!removed) {
    return 'There is no transaction to undo yet.';
  }

  return `Removed the last transaction: ${removed.merchant} (${(removed.amount_sgd / 100).toFixed(2)} SGD).`;
}
