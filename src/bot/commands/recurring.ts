/**
 * /recurring — every recurring charge, what they add up to each month, and a
 * button to remove each. Asking in chat ("show my subscriptions") gets this
 * same reply: the recurring intent's list action calls it.
 */

import { formatCurrency, toSGD } from '../../config/currencies';
import { listRecurring } from '../../expense/service';
import { getExchangeRates } from '../../fx/rates';
import { RecurringTransaction } from '../../types';
import { ordinal } from '../../utils/dates';
import { recurringList } from '../keyboards';
import { BotReply } from '../types';

function describeCharge(charge: RecurringTransaction, amountSgd: number): string {
  const amount =
    charge.currency === 'SGD'
      ? formatCurrency(charge.amount, 'SGD')
      : `${formatCurrency(charge.amount, charge.currency)} (${formatCurrency(amountSgd, 'SGD')})`;
  const paused = charge.is_active ? '' : ' (paused)';
  return `  ${ordinal(charge.day_of_month)} · ${charge.merchant} · ${amount} · ${charge.category}${paused}`;
}

export async function handleRecurringCommand(userId: string): Promise<BotReply> {
  const charges = await listRecurring(userId);
  if (charges.length === 0) {
    return { text: `No recurring charges yet. Add one like "Netflix $15.98 every 5th" and I'll log it on that day every month.` };
  }

  const rates = await getExchangeRates();
  const amountsSgd = charges.map((charge) => toSGD(charge.amount, charge.currency, rates));
  const monthlySgd = charges.reduce((sum, charge, index) => (charge.is_active ? sum + amountsSgd[index] : sum), 0);
  const heading =
    charges.length === 1
      ? `Your 1 recurring charge comes to ${formatCurrency(monthlySgd, 'SGD')} a month:`
      : `Your ${charges.length} recurring charges come to ${formatCurrency(monthlySgd, 'SGD')} a month:`;

  return {
    text: [
      heading,
      ...charges.map((charge, index) => describeCharge(charge, amountsSgd[index])),
      '',
      'Tap one to remove it. To change one, just say it again, e.g. "Netflix $17.98 every 5th".',
    ].join('\n'),
    keyboard: recurringList(charges.map((charge) => ({ id: charge.id, merchant: charge.merchant }))),
  };
}
