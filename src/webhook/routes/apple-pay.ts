/**
 * POST /api/apple-pay — logs an Apple Pay transaction from the iOS Shortcut
 * and sends a Telegram confirmation.
 */

import { Context } from 'hono';
import { Bot } from 'grammy';
import { logExpense } from '../../expense/service';
import { parseExplicitCurrency } from '../../expense/currency-resolver';
import { config, formatCurrency } from '../../config';
import { logger } from '../../utils/logger';
import { Currency, Transaction } from '../../types';
import { ApplePayPayload } from '../types';

function parseAmount(raw: unknown): { amount: number; currency?: Currency } | null {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }

  // POS terminals sometimes prefix the amount with a currency symbol/code
  // (e.g. "RM 45.00") — treat that as an explicit currency override.
  const currency = parseExplicitCurrency(raw);
  const numeric = raw.replace(/[^0-9.]/g, '');
  const amount = Number.parseFloat(numeric);

  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  return { amount, currency };
}

async function sendConfirmation(bot: Bot | null, transaction: Transaction): Promise<void> {
  if (!bot || !config.TELEGRAM_AUTHORIZED_CHAT_ID) {
    return;
  }

  const amountLabel = formatCurrency(transaction.amount, transaction.currency);
  const message = `Spent ${amountLabel} at ${transaction.merchant} — ${transaction.category}`;

  try {
    await bot.api.sendMessage(config.TELEGRAM_AUTHORIZED_CHAT_ID, message);
  } catch (error) {
    logger.error('Failed to send Apple Pay confirmation via Telegram', error);
  }
}

export function createApplePayHandler(bot: Bot | null) {
  return async (c: Context): Promise<Response> => {
    let payload: Partial<ApplePayPayload>;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ status: 'error', message: 'Invalid JSON payload' }, 400);
    }

    const parsedAmount = parseAmount(payload.amount);
    const merchant = typeof payload.merchant === 'string' ? payload.merchant.trim() : '';
    const card = typeof payload.card === 'string' ? payload.card.trim() : '';

    if (!parsedAmount || !merchant || !card) {
      return c.json({ status: 'error', message: 'amount, merchant, and card are required' }, 400);
    }

    try {
      const transaction = await logExpense({
        amount: parsedAmount.amount,
        currency: parsedAmount.currency,
        merchant,
        cardName: card,
        source: 'apple_pay',
      });

      await sendConfirmation(bot, transaction);

      return c.json(
        {
          status: 'logged',
          transaction: {
            amount: transaction.amount / 100,
            currency: transaction.currency,
            merchant: transaction.merchant,
            category: transaction.category,
          },
        },
        200,
      );
    } catch (error) {
      logger.error('Failed to log Apple Pay transaction from webhook', error);
      return c.json({ status: 'error', message: 'Failed to log transaction' }, 500);
    }
  };
}
