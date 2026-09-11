/**
 * Gemini-powered intent extraction and reply generation for the Telegram assistant
 */

import { getProviderForUser } from '../llm/provider';
import { findById } from '../users/service';
import { logger } from '../utils/logger';
import { formatUserFriendlyError } from './formatter/messages';
import { BotIntent } from './types';
import { AssetClass, Currency } from '../types';
import { isPricedCrypto } from '../portfolio/price-fetcher/crypto';
import { ExpenseSource, SpendingPeriod } from '../expense/types';

const HOLDING_ASSET_CLASSES = new Set<string>(['crypto', 'cash', 'stocks_us', 'stocks_sg', 'stocks_my']);
const HOLDING_MARKET: Record<AssetClass, string> = {
  crypto: 'Crypto',
  cash: 'Cash',
  stocks_us: 'US',
  stocks_sg: 'SGX',
  stocks_my: 'Bursa',
};
// A stock is priced in its listing currency, whatever the message said.
const LISTING_CURRENCY: Partial<Record<AssetClass, Currency>> = {
  stocks_us: 'USD',
  stocks_sg: 'SGD',
  stocks_my: 'MYR',
};
const CASH_CURRENCIES = new Set(['SGD', 'MYR', 'USD']);

/**
 * The classifier's asset class when it gave a valid one; otherwise inferred
 * only where it's unambiguous (a coin with a price source, or a currency code
 * as cash). Anything else returns null so the bot asks. It used to default
 * to crypto, which filed "10 AAPL" as a coin that could never be priced.
 */
function resolveHoldingAssetClass(symbol: string, assetClass: string | undefined): AssetClass | null {
  if (assetClass && HOLDING_ASSET_CLASSES.has(assetClass)) {
    return assetClass as AssetClass;
  }
  if (isPricedCrypto(symbol)) {
    return 'crypto';
  }
  if (CASH_CURRENCIES.has(symbol)) {
    return 'cash';
  }
  return null;
}

function resolveHoldingCurrency(symbol: string, assetClass: AssetClass, currency: string | undefined): Currency {
  const listing = LISTING_CURRENCY[assetClass];
  if (listing) {
    return listing;
  }
  if (currency && VALID_CURRENCIES.has(currency)) {
    return currency as Currency;
  }
  if (assetClass === 'cash' && CASH_CURRENCIES.has(symbol)) {
    return symbol as Currency;
  }
  return 'USD';
}
const VALID_CURRENCIES = new Set(['SGD', 'MYR', 'USD', 'BTC', 'ETH', 'BETH']);
const VALID_SPENDING_PERIODS = new Set(['today', 'week', 'month']);

export interface ExtractedFields {
  amount?: number;
  merchant?: string;
  category?: string;
  period?: string;
  budgetAmount?: number;
  action?: string;
  symbol?: string;
  assetClass?: string;
  currency?: string;
  dayOfMonth?: number;
}

export interface IntentAnalysis {
  intent: BotIntent;
  confidence: number;
  extracted: ExtractedFields;
  rawText: string;
  /** Set when this result is a degraded response to a Gemini call failure, not a real classification. */
  serviceError?: boolean;
}

/**
 * Returned when Gemini itself fails (timeout, network error, unparseable response).
 * There is deliberately no rule-based classification here — Pluto AI is Gemini-first,
 * see doc/tasks/02-telegram-bot.md. A failure is surfaced as "unknown" with serviceError
 * set, not silently guessed via keyword matching.
 */
function gracefulUnknown(rawText: string): IntentAnalysis {
  return {
    intent: 'unknown',
    confidence: 0,
    extracted: {},
    rawText,
    serviceError: true,
  };
}

function safeJsonParse(text: string): Partial<IntentAnalysis> | null {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function classifyUserMessage(userId: string, rawText: string): Promise<IntentAnalysis> {
  const trimmed = rawText.trim();

  if (!trimmed) {
    return {
      intent: 'unknown',
      confidence: 0,
      extracted: {},
      rawText: '',
    };
  }

  try {
    const user = await findById(userId);
    if (!user) {
      throw new Error(`No user found with id ${userId}`);
    }
    const provider = getProviderForUser(user);

    const prompt = `User message: "${trimmed}"\n\nReturn only valid JSON with keys intent, confidence, extracted, rawText.`;

    // gemini-3.6-flash's reasoning overhead routinely takes ~5s for this
    // prompt, so the timeout needs enough headroom to not misfire as a
    // service error.
    const response = await provider.generateText({
      systemInstruction:
        'You are Pluto AI, a personal finance assistant in Telegram. Classify each user message and return strict JSON only. Return fields: intent, confidence, extracted { amount, merchant, category, period, budgetAmount, action, symbol, assetClass, currency, dayOfMonth }, rawText. Allowed intents: expense, query, budget, correction, recurring, holdings, help, unknown. The holdings intent covers portfolio holdings entered by hand, like "I hold 0.5 BTC", "I hold 10 AAPL shares", "I have 1000 DBS shares" or "cash SGD 5000" — extract symbol as the coin or exchange ticker code, never a company name (BTC, AAPL, SGD; for SGX and Bursa stocks the exchange stock code, e.g. DBS is D05, Singapore Airlines is C6L, Maybank is 1155), assetClass (one of crypto, cash, stocks_us, stocks_sg, stocks_my), currency, and amount as the quantity; set action="remove" when the user wants a holding removed. The recurring intent covers repeating charges like "Netflix $15.98 every 5th" or "cancel my Spotify subscription" — extract merchant, amount, and dayOfMonth (1-31, the day of the month it recurs on) for a new one, or action="remove" and merchant for cancelling an existing one. The query intent covers spending questions like "how much did I spend this week" — extract period as one of today, week, or month. Use decimal numbers for money values like 4.5. Keep responses concise and practical.',
      contents: [{ text: prompt }],
      timeoutMs: 15000,
    });

    const parsed = safeJsonParse(response);

    if (!parsed) {
      logger.warn('Gemini returned an unparseable response, degrading to unknown intent', { response });
      return gracefulUnknown(trimmed);
    }

    const intent = (parsed.intent as BotIntent | undefined) ?? 'unknown';
    const confidence = Number(parsed.confidence ?? 0.7);

    return {
      intent,
      confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.7,
      extracted: parsed.extracted ?? {},
      rawText: String(parsed.rawText ?? trimmed),
    };
  } catch (error) {
    logger.error('Gemini classification failed', error);
    return gracefulUnknown(trimmed);
  }
}

export async function buildAssistantReply(
  userId: string,
  result: IntentAnalysis,
  source: ExpenseSource = 'text',
): Promise<string> {
  const { intent, extracted, rawText, serviceError } = result;

  if (serviceError) {
    return formatUserFriendlyError();
  }

  switch (intent) {
    case 'expense': {
      const { logExpense } = await import('../expense/service');

      const amount = extracted.amount ?? 0;
      if (amount <= 0) {
        return `How much did you spend? Try "Spent $4.50 at Ya Kun".`;
      }

      const currency: Currency | undefined = VALID_CURRENCIES.has(extracted.currency ?? '')
        ? (extracted.currency as Currency)
        : undefined;

      const transaction = await logExpense(userId, {
        amount,
        currency,
        merchant: extracted.merchant,
        source,
      });

      return `Logged S$${(transaction.amount_sgd / 100).toFixed(2)} at ${transaction.merchant} under ${transaction.category}.`;
    }
    case 'budget': {
      const { setBudget, removeBudget } = await import('../budget/service');
      const { normalizeCategoryName } = await import('../expense/categorizer');

      if (!extracted.category) {
        return `Sure — which category's budget should I update? Try "Set food budget to $800/month".`;
      }

      const category = normalizeCategoryName(extracted.category);
      const isRemoval = /remove|delete|cancel/i.test(extracted.action ?? rawText);

      if (isRemoval) {
        await removeBudget(userId, category);
        return `Done — removed the ${category} budget.`;
      }

      const amount = extracted.budgetAmount ?? extracted.amount ?? 0;
      if (amount <= 0) {
        return `What amount should the ${category} budget be? Try "Set food budget to $800/month".`;
      }

      const budget = await setBudget(userId, category, amount);
      return `Got it — ${category} budget set to S$${(budget.amount_sgd / 100).toFixed(2)}/month.`;
    }
    case 'correction': {
      // Import dynamically to avoid circular dependencies
      const { correctLastTransaction } = await import('../expense/service');

      // Determine what field to correct based on extracted data
      let field = 'category'; // default
      let value = extracted.category || rawText;

      if (extracted.merchant) {
        field = 'merchant';
        value = extracted.merchant;
      } else if (extracted.amount) {
        field = 'amount';
        value = extracted.amount.toString();
      } else if (extracted.category) {
        field = 'category';
        value = extracted.category;
      }

      const corrected = await correctLastTransaction(userId, field, value);

      if (!corrected) {
        return `I couldn't find a recent transaction to correct. Try logging an expense first!`;
      }

      return `Updated! Changed ${field} to "${value}" for your last transaction.`;
    }
    case 'recurring': {
      const { createRecurring, listRecurring, removeRecurring } = await import('../expense/service');

      if (!extracted.merchant) {
        return `Which recurring merchant? Try "Netflix $15.98 every 5th" or "cancel my Spotify subscription".`;
      }

      const isRemoval = /remove|delete|cancel|stop/i.test(extracted.action ?? rawText);

      if (isRemoval) {
        const all = await listRecurring(userId);
        const match = all.find((r) => r.merchant.toLowerCase() === extracted.merchant!.toLowerCase());

        if (!match) {
          return `I couldn't find a recurring entry for "${extracted.merchant}".`;
        }

        await removeRecurring(userId, match.id);
        return `Done — removed the recurring ${match.merchant} charge.`;
      }

      const amount = extracted.amount ?? 0;
      if (amount <= 0) {
        return `How much is the ${extracted.merchant} charge?`;
      }

      const dayOfMonth = extracted.dayOfMonth;
      if (!dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31) {
        return `Which day of the month does ${extracted.merchant} charge you?`;
      }

      const currency: Currency | undefined = VALID_CURRENCIES.has(extracted.currency ?? '')
        ? (extracted.currency as Currency)
        : undefined;

      const recurring = await createRecurring(userId, {
        amount,
        currency,
        merchant: extracted.merchant,
        day_of_month: dayOfMonth,
      });

      return `Got it — I'll log $${amount.toFixed(2)} at ${recurring.merchant} every month on day ${recurring.day_of_month}.`;
    }
    case 'holdings': {
      const { addHolding, removeHolding, findStatementHolding, StatementHoldingConflictError } = await import(
        '../portfolio/service'
      );

      if (!extracted.symbol) {
        return `Which holding? Try "I hold 0.5 BTC", "I hold 10 AAPL shares" or "cash SGD 5000".`;
      }

      const symbol = extracted.symbol.trim().toUpperCase();
      const isRemoval = /remove|delete/i.test(extracted.action ?? rawText);

      if (isRemoval) {
        if ((await removeHolding(userId, symbol)) > 0) {
          return `Done — removed ${symbol} from your holdings.`;
        }
        const broker = await findStatementHolding(userId, symbol);
        return broker
          ? `${symbol} comes from your ${broker.toUpperCase()} statement, so it can't be removed by hand — upload a newer statement and it will drop off once you've sold it.`
          : `You don't have a ${symbol} holding to remove.`;
      }

      const quantity = extracted.amount ?? 0;
      if (quantity <= 0) {
        return `How much ${symbol} do you hold?`;
      }

      const assetClass = resolveHoldingAssetClass(symbol, extracted.assetClass);
      if (!assetClass) {
        return `Is ${symbol} a crypto coin or a stock? For a stock, try "I hold ${quantity} ${symbol} shares".`;
      }

      let holding;
      try {
        holding = await addHolding(userId, {
          symbol,
          name: symbol,
          quantity,
          asset_class: assetClass,
          currency: resolveHoldingCurrency(symbol, assetClass, extracted.currency),
          market: HOLDING_MARKET[assetClass],
        });
      } catch (error) {
        if (error instanceof StatementHoldingConflictError) {
          return `${symbol} is already in your ${error.broker.toUpperCase()} statement holdings — upload a newer statement to change it, so it isn't counted twice.`;
        }
        throw error;
      }

      if (assetClass === 'crypto' && !isPricedCrypto(symbol)) {
        return `Recorded ${holding.quantity} ${holding.symbol}, but I don't have a price source for ${symbol} yet, so it counts as S$0 in your net worth.`;
      }
      return `Got it — recorded ${holding.quantity} ${holding.symbol}.`;
    }
    case 'query': {
      const { getSpendingSummary } = await import('../expense/service');
      const { formatSpendingSummary } = await import('./formatter/messages');

      const period: SpendingPeriod = VALID_SPENDING_PERIODS.has(extracted.period ?? '')
        ? (extracted.period as SpendingPeriod)
        : 'month';

      const summary = await getSpendingSummary(userId, period);
      const label = period === 'today' ? "Today's spend" : period === 'week' ? "This week's spend" : "This month's spend";

      return formatSpendingSummary(label, summary);
    }
    case 'help': {
      return `Here's what I can do: /portfolio, /today, /month, /budget, /export, /undo, /help. You can also just message me naturally.`;
    }
    default:
      return `I'm not totally sure what you mean there, but I'm happy to help. Try /help or send something like "Spent $4.50 at Ya Kun".`;
  }
}
