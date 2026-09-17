/**
 * Applying edits to a logged expense, shared by chat corrections ("actually
 * it was $12", "change my NTUC expense last Tuesday to $40") and the buttons
 * offered when a described expense matches several.
 */

import { budgetAlertFor } from '../../budget/alerts';
import { correctTransaction } from '../../expense/service';
import { Transaction } from '../../types';
import { formatExpenseLine } from '../formatter/messages';
import { TransactionEdit, transactionActions } from '../keyboards';

/** Currency goes before amount, so the amount's SGD value uses the corrected currency. */
const FIELD_ORDER: TransactionEdit['field'][] = ['currency', 'amount', 'merchant', 'category', 'date'];

/**
 * Applies each edit to the transaction (scoped to the user), or with a null
 * id to the latest. Null when there is no such transaction.
 */
export async function applyEdits(
  userId: string,
  transactionId: string | null,
  edits: TransactionEdit[],
): Promise<Transaction | null> {
  const ordered = [...edits].sort((a, b) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field));
  let corrected: Transaction | null = null;
  for (const edit of ordered) {
    corrected = await correctTransaction(userId, corrected?.id ?? transactionId, edit.field, edit.value);
    if (!corrected) {
      return null;
    }
  }
  return corrected;
}

/** "Updated …" with the buttons, and any budget alert a changed amount, currency, category or date set off. */
export async function editedReply(
  userId: string,
  transaction: Transaction,
  edits: TransactionEdit[],
  which: string,
  now: Date = new Date(),
): Promise<{ text: string; keyboard: ReturnType<typeof transactionActions> }> {
  const reply = `Updated ${which}: ${formatExpenseLine(transaction, now)}.`;
  const alert = edits.some((edit) => edit.field !== 'merchant') ? await budgetAlertFor(userId, transaction) : null;
  return {
    text: alert ? `${reply}\n\n${alert}` : reply,
    keyboard: transactionActions(transaction.id, 'c', Boolean(transaction.photo_file_id)),
  };
}
