/**
 * Gemini-powered intent extraction and reply generation for the Telegram assistant
 */

import { getProviderForUser } from '../llm/provider';
import { findById } from '../users/service';
import { logger } from '../utils/logger';
import {
  formatCategorySpend,
  formatHelpMessage,
  formatMoneyWithSgd,
  formatSpendingSummary,
  formatUserFriendlyError,
} from './formatter/messages';
import { BotIntent } from './types';
import { Currency, Transaction } from '../types';
import { isPricedCrypto } from '../portfolio/price-fetcher/crypto';
import { ExpenseSource, SpendingPeriod } from '../expense/types';

// Only crypto and cash are entered in chat. Stocks and ETFs come from statement
// imports and are valued at the statement's prices; a stock typed into chat
// would have no price to value it with.
const MANUAL_ASSET_CLASSES = new Set<string>(['crypto', 'cash']);
const STOCK_ASSET_CLASSES = new Set<string>(['stocks_us', 'stocks_sg', 'stocks_my']);
const CASH_CURRENCIES = new Set(['SGD', 'MYR', 'USD']);
const STATEMENT_UPLOAD_HINT =
  "Stocks and ETFs come from your brokerage statements, valued at the statement's prices. Send me a statement as a file (PDF, screenshot or CSV) and I'll import every position.";

/**
 * The classifier's asset class when it's crypto or cash; otherwise inferred
 * only where unambiguous (a coin with a price source, or a currency code as
 * cash). Anything else returns null so the bot asks rather than guessing.
 * Defaulting to crypto once filed "10 AAPL" as a coin that could never be
 * priced.
 */
function resolveManualAssetClass(symbol: string, assetClass: string | undefined): 'crypto' | 'cash' | null {
  if (assetClass && MANUAL_ASSET_CLASSES.has(assetClass)) {
    return assetClass as 'crypto' | 'cash';
  }
  if (isPricedCrypto(symbol)) {
    return 'crypto';
  }
  if (CASH_CURRENCIES.has(symbol)) {
    return 'cash';
  }
  return null;
}

function resolveHoldingCurrency(symbol: string, assetClass: 'crypto' | 'cash', currency: string | undefined): Currency {
  if (currency && VALID_CURRENCIES.has(currency)) {
    return currency as Currency;
  }
  if (assetClass === 'cash' && CASH_CURRENCIES.has(symbol)) {
    return symbol as Currency;
  }
  return 'USD';
}
const VALID_CURRENCIES = new Set(['SGD', 'MYR', 'USD']);
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
        'You are Pluto AI, a personal finance assistant in Telegram. Classify each user message and return strict JSON only. Return fields: intent, confidence, extracted { amount, merchant, category, period, budgetAmount, action, symbol, assetClass, currency, dayOfMonth }, rawText. Allowed intents: expense, query, budget, correction, recurring, holdings, help, unknown. The holdings intent covers portfolio holdings mentioned in chat, like "I hold 0.5 BTC", "cash SGD 5000" or "I have 10 AAPL shares" — extract symbol (the coin, currency or ticker symbol, never a company name), assetClass (crypto, cash, or stocks_us, stocks_sg or stocks_my when it is a stock or ETF), currency, and amount as the quantity; set action="remove" when the user wants a holding removed. The recurring intent covers repeating charges like "Netflix $15.98 every 5th" or "cancel my Spotify subscription" — extract merchant, amount, and dayOfMonth (1-31, the day of the month it recurs on) for a new one, or action="remove" and merchant for cancelling an existing one. The query intent covers spending questions like "how much did I spend this week" or "how much on food this month" — extract period as one of today, week, or month, and category when the question is about one category. The correction intent covers fixing the last logged expense, like "actually that was $12", "it was in ringgit" or "that was Transport" — extract whichever of amount, currency, merchant and category the user is changing. A category is one of Food, Transport, Groceries, Entertainment, Bills, Health, Education, Travel, Shopping or Others; a currency is SGD, MYR (ringgit, RM) or USD. Use decimal numbers for money values like 4.5. Keep responses concise and practical.',
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

/** Adds the budget alert this expense triggered, if any, below the reply. */
async function withBudgetAlert(userId: string, reply: string, transaction: Transaction): Promise<string> {
  const { budgetAlertFor } = await import('../budget/alerts');
  const alert = await budgetAlertFor(userId, transaction);
  return alert ? `${reply}\n\n${alert}` : reply;
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

      return withBudgetAlert(
        userId,
        `Logged ${formatMoneyWithSgd(transaction)} at ${transaction.merchant} under ${transaction.category}.`,
        transaction,
      );
    }
    case 'budget': {
      const { setBudget, removeBudget, findBudgetByCategory } = await import('../budget/service');
      const { matchCategory, VALID_CATEGORIES } = await import('../expense/categorizer');

      if (!extracted.category) {
        return `Sure — which category's budget should I update? Try "Set food budget to $800/month".`;
      }

      // An unrecognized category used to become an "Others" budget silently.
      const category = matchCategory(extracted.category);
      if (!category) {
        return `Budgets are set per category: ${VALID_CATEGORIES.join(', ')}. Which one should "${extracted.category}" be?`;
      }
      const isRemoval = /remove|delete|cancel/i.test(extracted.action ?? rawText);

      if (isRemoval) {
        if (!(await findBudgetByCategory(userId, category))) {
          return `You don't have a ${category} budget to remove.`;
        }
        await removeBudget(userId, category);
        return `Done — removed the ${category} budget.`;
      }

      const amount = extracted.budgetAmount ?? extracted.amount ?? 0;
      if (amount <= 0) {
        return `What amount should the ${category} budget be? Try "Set food budget to $800/month".`;
      }

      const currency: Currency = VALID_CURRENCIES.has(extracted.currency ?? '') ? (extracted.currency as Currency) : 'SGD';
      const budget = await setBudget(userId, category, amount, currency);
      return `Got it — ${category} budget set to ${formatMoneyWithSgd(budget)} a month.`;
    }
    case 'correction': {
      const { correctLastTransaction } = await import('../expense/service');

      // Apply every field the message names. Currency goes before amount so the
      // amount's SGD value is worked out in the corrected currency. With
      // nothing identifiable, ask: this used to re-categorize the transaction
      // using the whole message as a hint, so "it was in ringgit" changed the
      // category and left the currency wrong.
      const changes: Array<[string, string]> = [];
      if (extracted.currency && VALID_CURRENCIES.has(extracted.currency)) {
        changes.push(['currency', extracted.currency]);
      }
      if (extracted.amount && extracted.amount > 0) {
        changes.push(['amount', String(extracted.amount)]);
      }
      if (extracted.merchant) {
        changes.push(['merchant', extracted.merchant]);
      }
      if (extracted.category) {
        changes.push(['category', extracted.category]);
      }

      if (changes.length === 0) {
        return `What should I change on your last transaction: the amount, currency, merchant or category? Try "actually it was $12" or "that was Transport".`;
      }

      let corrected: Transaction | null = null;
      for (const [field, value] of changes) {
        corrected = await correctLastTransaction(userId, field, value);
        if (!corrected) {
          return `I couldn't find a recent transaction to correct. Try logging an expense first!`;
        }
      }

      const transaction = corrected as Transaction;
      const reply = `Updated your last transaction: ${formatMoneyWithSgd(transaction)} at ${transaction.merchant} under ${transaction.category}.`;
      // A new amount, currency or category can push a budget over a threshold.
      return changes.some(([field]) => field !== 'merchant') ? withBudgetAlert(userId, reply, transaction) : reply;
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

      if (extracted.assetClass && STOCK_ASSET_CLASSES.has(extracted.assetClass)) {
        return STATEMENT_UPLOAD_HINT;
      }

      const quantity = extracted.amount ?? 0;
      if (quantity <= 0) {
        return `How much ${symbol} do you hold?`;
      }

      const assetClass = resolveManualAssetClass(symbol, extracted.assetClass);
      if (!assetClass) {
        return `Is ${symbol} a crypto coin? If so, say "I hold ${quantity} ${symbol} coins". ${STATEMENT_UPLOAD_HINT}`;
      }

      let holding;
      try {
        holding = await addHolding(userId, {
          symbol,
          name: symbol,
          quantity,
          asset_class: assetClass,
          currency: resolveHoldingCurrency(symbol, assetClass, extracted.currency),
          market: assetClass === 'cash' ? 'Cash' : 'Crypto',
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
      const { matchCategory } = await import('../expense/categorizer');

      const period: SpendingPeriod = VALID_SPENDING_PERIODS.has(extracted.period ?? '')
        ? (extracted.period as SpendingPeriod)
        : 'month';

      const summary = await getSpendingSummary(userId, period);
      // "week" is the last 7 days, not the calendar week, so the label says that.
      const label = period === 'today' ? "Today's spend" : period === 'week' ? "Last 7 days' spend" : "This month's spend";

      // "How much on food?" answers for food, not the whole breakdown.
      const category = extracted.category ? matchCategory(extracted.category) : null;
      if (category) {
        let budget;
        if (period === 'month') {
          const { getBudgetStatus } = await import('../budget/progress');
          budget = (await getBudgetStatus(userId)).find((status) => status.category === category);
        }
        return formatCategorySpend(
          label,
          category,
          summary.byCategory[category] ?? 0,
          summary.byCategoryCount[category] ?? 0,
          budget,
        );
      }

      return formatSpendingSummary(label, summary);
    }
    case 'help': {
      return formatHelpMessage();
    }
    default:
      return `I'm not totally sure what you mean there, but I'm happy to help. Try /help or send something like "Spent $4.50 at Ya Kun".`;
  }
}
