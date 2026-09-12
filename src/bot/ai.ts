/**
 * Gemini-powered intent extraction and reply generation for the Telegram assistant
 */

import { getProviderForUser } from '../llm/provider';
import { findById } from '../users/service';
import { logger } from '../utils/logger';
import { earlierDay, formatDay, isFutureDay, ordinal, parseIsoDate, toIsoDate } from '../utils/dates';
import { formatCurrency } from '../config/currencies';
import {
  formatCategorySpend,
  formatExpenseLine,
  formatHelpMessage,
  formatMoneyWithSgd,
  formatSpendingSummary,
  formatUserFriendlyError,
} from './formatter/messages';
import { coinPicker, incomeActions, transactionActions } from './keyboards';
import { BotIntent, BotReply } from './types';
import { Currency, OVERALL_BUDGET, Transaction } from '../types';
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

function currencyFrom(raw: string | undefined): Currency | undefined {
  return raw && VALID_CURRENCIES.has(raw) ? (raw as Currency) : undefined;
}

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
  /** "YYYY-MM-DD", when the message puts an expense, income or correction on another day. */
  date?: string;
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
 * Returned when Gemini itself fails (timeout, network error, unparseable
 * response). There is deliberately no rule-based classification here —
 * Plutus is Gemini-first. A failure is surfaced as "unknown" with
 * serviceError set, not silently guessed via keyword matching.
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

const CLASSIFIER_INSTRUCTION = [
  'You are Plutus AI, a personal finance assistant in Telegram. Classify each user message and return strict JSON only, with fields: intent, confidence, extracted { amount, merchant, category, period, budgetAmount, action, symbol, assetClass, currency, dayOfMonth, date }, rawText.',
  'Allowed intents: expense, income, query, budget, correction, recurring, holdings, help, unknown.',
  'The expense intent covers money spent, like "Spent $4.50 at Ya Kun" or "Grab 18 yesterday" — extract amount, merchant, currency, and category as the best category for it.',
  'The income intent covers money coming in, like "Salary $5200 came in", "got paid RM 4000" or "freelance job $800" — extract amount, currency, and merchant as what the income was (Salary, Freelance, Bonus and so on).',
  'For expense, income and correction, extract date as YYYY-MM-DD when the user says it happened on a day other than today ("yesterday", "last Friday", "on the 3rd"), working it out from the date given with the message; leave date out otherwise.',
  'The holdings intent covers portfolio holdings mentioned in chat, like "I hold 0.5 BTC", "cash SGD 5000" or "I have 10 AAPL shares" — extract symbol (the coin, currency or ticker symbol, never a company name), assetClass (crypto, cash, or stocks_us, stocks_sg or stocks_my when it is a stock or ETF), currency, and amount as the quantity; set action="remove" when the user wants a holding removed.',
  'The recurring intent covers monthly repeating charges: adding or changing one, like "Netflix $15.98 every 5th" or "Netflix is now $17.98" — extract merchant, amount, currency, and dayOfMonth (1-31, the day of the month it recurs on); cancelling one, like "cancel my Spotify subscription" — action="remove" and merchant; or seeing them all, like "show my recurring expenses" or "what subscriptions do I have" — action="list".',
  'The query intent covers spending questions like "how much did I spend this week" or "how much on food this month" — extract period as one of today, week, or month, and category when the question is about one category.',
  'The budget intent sets or removes a monthly budget, like "Set food budget to $500" or "remove my travel budget" — extract category, budgetAmount and currency, and action="remove" for a removal. For a budget on all spending ("monthly budget $3000", "overall budget", "total budget"), set category to Overall.',
  'The correction intent covers fixing a logged expense, like "actually that was $12", "it was in ringgit", "that was Transport" or "that was yesterday" — extract whichever of amount, currency, merchant, category and date the user is changing.',
  'A category is one of Food, Transport, Groceries, Entertainment, Bills, Health, Education, Travel, Shopping or Others; a currency is SGD, MYR (ringgit, RM) or USD. Use decimal numbers for money values like 4.5. Keep responses concise and practical.',
].join(' ');

/** `now` is injectable for tests; the classifier needs today's date to resolve "yesterday". */
export async function classifyUserMessage(userId: string, rawText: string, now: Date = new Date()): Promise<IntentAnalysis> {
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

    const today = `${now.toLocaleDateString('en-SG', { weekday: 'long' })} ${toIsoDate(now)}`;
    const prompt = `Today is ${today}.\nUser message: "${trimmed}"\n\nReturn only valid JSON with keys intent, confidence, extracted, rawText.`;

    // gemini-3.6-flash's reasoning overhead routinely takes ~5s for this
    // prompt, so the timeout needs enough headroom to not misfire as a
    // service error.
    const response = await provider.generateText({
      systemInstruction: CLASSIFIER_INSTRUCTION,
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

export interface ReplyOptions {
  /** How an expense in this message gets logged: 'text' (the default) or 'voice'. */
  source?: ExpenseSource;
  /**
   * The transaction whose confirmation the user replied to. A correction
   * changes that one instead of the latest.
   */
  targetTransactionId?: string | null;
  /** Injectable for tests. */
  now?: Date;
}

export async function buildAssistantReply(
  userId: string,
  result: IntentAnalysis,
  options: ReplyOptions = {},
): Promise<BotReply> {
  if (result.serviceError) {
    return { text: formatUserFriendlyError() };
  }
  const reply = await replyForIntent(userId, result, {
    source: options.source ?? 'text',
    targetTransactionId: options.targetTransactionId ?? null,
    now: options.now ?? new Date(),
  });
  return typeof reply === 'string' ? { text: reply } : reply;
}

async function replyForIntent(
  userId: string,
  result: IntentAnalysis,
  options: Required<ReplyOptions>,
): Promise<string | BotReply> {
  const { intent, extracted, rawText } = result;
  const { source, targetTransactionId, now } = options;

  switch (intent) {
    case 'expense': {
      const { logExpense } = await import('../expense/service');
      const { matchCategory } = await import('../expense/categorizer');

      const amount = extracted.amount ?? 0;
      if (amount <= 0) {
        return `How much did you spend? Try "Spent $4.50 at Ya Kun".`;
      }

      const transaction = await logExpense(userId, {
        amount,
        currency: currencyFrom(extracted.currency),
        merchant: extracted.merchant,
        source,
        // The classifier has already categorized it; logExpense still prefers
        // the user's own history with the merchant, and no longer needs a
        // second LLM call for a new one.
        categoryHint: (extracted.category && matchCategory(extracted.category)) || undefined,
        spentAt: earlierDay(extracted.date, now),
      });

      return {
        text: await withBudgetAlert(userId, `Logged ${formatExpenseLine(transaction, now)}.`, transaction),
        keyboard: transactionActions(transaction.id),
      };
    }
    case 'income': {
      const { logIncome } = await import('../income/service');

      const amount = extracted.amount ?? 0;
      if (amount <= 0) {
        return `How much came in? Try "Salary $5200".`;
      }

      const receivedAt = earlierDay(extracted.date, now);
      const entry = await logIncome(userId, {
        amount,
        currency: currencyFrom(extracted.currency),
        source: extracted.merchant,
        receivedAt,
      });
      const dated = receivedAt ? `, on ${formatDay(entry.received_at)}` : '';
      return {
        text: `Recorded ${formatMoneyWithSgd(entry)} of income from ${entry.source}${dated}. /month shows your savings rate.`,
        keyboard: incomeActions(entry.id),
      };
    }
    case 'budget': {
      const { setBudget, removeBudget, findBudgetByCategory, matchBudgetCategory } = await import('../budget/service');
      const { VALID_CATEGORIES } = await import('../expense/categorizer');

      if (!extracted.category) {
        return `Sure — which category's budget should I update? Try "Set food budget to $800/month", or "Monthly budget $3000" for all spending.`;
      }

      // An unrecognized category used to become an "Others" budget silently.
      const category = matchBudgetCategory(extracted.category);
      if (!category) {
        return `Budgets are set per category (${VALID_CATEGORIES.join(', ')}), or ${OVERALL_BUDGET} for all spending. Which one should "${extracted.category}" be?`;
      }
      const label = category === OVERALL_BUDGET ? 'overall' : category;
      const isRemoval = /remove|delete|cancel/i.test(extracted.action ?? rawText);

      if (isRemoval) {
        if (!(await findBudgetByCategory(userId, category))) {
          return `You don't have ${category === OVERALL_BUDGET ? 'an overall' : `a ${category}`} budget to remove.`;
        }
        await removeBudget(userId, category);
        return `Done — removed the ${label} budget.`;
      }

      const amount = extracted.budgetAmount ?? extracted.amount ?? 0;
      if (amount <= 0) {
        return `What amount should the ${label} budget be? Try "Set food budget to $800/month".`;
      }

      const budget = await setBudget(userId, category, amount, currencyFrom(extracted.currency) ?? 'SGD');
      return category === OVERALL_BUDGET
        ? `Got it — overall budget set to ${formatMoneyWithSgd(budget)} a month, across all spending.`
        : `Got it — ${category} budget set to ${formatMoneyWithSgd(budget)} a month.`;
    }
    case 'correction': {
      const { correctTransaction } = await import('../expense/service');

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
      const date = parseIsoDate(extracted.date);
      if (date && !isFutureDay(date, now)) {
        changes.push(['date', toIsoDate(date)]);
      }

      if (changes.length === 0) {
        return `What should I change: the amount, currency, merchant, category or date? Try "actually it was $12", "that was Transport" or "that was yesterday".`;
      }

      let corrected: Transaction | null = null;
      for (const [field, value] of changes) {
        corrected = await correctTransaction(userId, targetTransactionId, field, value);
        if (!corrected) {
          return targetTransactionId
            ? `I couldn't find that expense — it may have been deleted. /recent shows what's there.`
            : `I couldn't find a recent transaction to correct. Try logging an expense first!`;
        }
      }

      const transaction = corrected as Transaction;
      const which = targetTransactionId ? 'that expense' : 'your last expense';
      const reply = `Updated ${which}: ${formatExpenseLine(transaction, now)}.`;
      // A new amount, currency, category or date can push a budget over a threshold.
      return {
        text: changes.some(([field]) => field !== 'merchant') ? await withBudgetAlert(userId, reply, transaction) : reply,
        keyboard: transactionActions(transaction.id),
      };
    }
    case 'recurring': {
      const { createRecurring, findRecurringForMerchant, logRecurringIfDue, matchRecurring, removeRecurring } =
        await import('../expense/service');

      // "Show my subscriptions" gets exactly what /recurring shows.
      if (extracted.action === 'list') {
        const { handleRecurringCommand } = await import('./commands/recurring');
        return handleRecurringCommand(userId);
      }

      if (!extracted.merchant) {
        return `Which recurring charge? Try "Netflix $15.98 every 5th" or "cancel my Spotify subscription", or /recurring to see them all.`;
      }

      const isRemoval = /remove|delete|cancel|stop/i.test(extracted.action ?? rawText);

      if (isRemoval) {
        const matches = await matchRecurring(userId, extracted.merchant);
        if (matches.length === 0) {
          return `I couldn't find a recurring charge for "${extracted.merchant}". /recurring shows the ones you have.`;
        }
        if (matches.length > 1) {
          const names = matches.map((charge) => charge.merchant);
          return `Which one? You have ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}. Say the full name, or remove it from /recurring.`;
        }
        await removeRecurring(userId, matches[0].id);
        return `Done — removed the recurring ${matches[0].merchant} charge.`;
      }

      const amount = extracted.amount ?? 0;
      if (amount <= 0) {
        return `How much is the ${extracted.merchant} charge?`;
      }

      const dayOfMonth = extracted.dayOfMonth;
      if (!dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31) {
        return `Which day of the month does ${extracted.merchant} charge you?`;
      }

      // Saying an existing charge again changes it rather than adding a second one.
      const previous = await findRecurringForMerchant(userId, extracted.merchant);
      const recurring = await createRecurring(userId, {
        amount,
        currency: currencyFrom(extracted.currency),
        merchant: extracted.merchant,
        day_of_month: dayOfMonth,
      });

      const lastDayNote = recurring.day_of_month > 28 ? ' (or the last day, in shorter months)' : '';
      const schedule = `${formatCurrency(recurring.amount, recurring.currency)} at ${recurring.merchant} on the ${ordinal(recurring.day_of_month)} of every month${lastDayNote}`;
      const confirmation = previous ? `Updated — I'll now log ${schedule}.` : `Got it — I'll log ${schedule}.`;

      // Due today? The daily job has already run, so log this month's now.
      const loggedNow = await logRecurringIfDue(userId, recurring.id, now);
      if (!loggedNow) {
        return confirmation;
      }
      return {
        text: await withBudgetAlert(
          userId,
          `${confirmation}\n\nIt's due today, so I've logged this month's ${formatMoneyWithSgd(loggedNow)} already.`,
          loggedNow,
        ),
        keyboard: transactionActions(loggedNow.id),
      };
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

      if (assetClass === 'crypto' && !isPricedCrypto(symbol) && !holding.coingecko_id) {
        // Not in the built-in table: offer CoinGecko's exact-ticker matches
        // and let the user say which. Unrelated tokens share tickers, so
        // picking one for them could price the wrong coin.
        const { searchCoins } = await import('../portfolio/price-fetcher/crypto');
        const candidates = await searchCoins(symbol);
        if (candidates.length > 0) {
          return {
            text: `Recorded ${holding.quantity} ${holding.symbol}. Which coin is your ${symbol}? I'll price it live from CoinGecko.`,
            keyboard: coinPicker(symbol, candidates),
          };
        }
        return `Recorded ${holding.quantity} ${holding.symbol}, but I couldn't find ${symbol} on CoinGecko, so it counts as S$0 in your net worth.`;
      }
      return `Got it — recorded ${holding.quantity} ${holding.symbol}.`;
    }
    case 'query': {
      const { getSpendingSummary } = await import('../expense/service');
      const { matchCategory } = await import('../expense/categorizer');

      const period: SpendingPeriod = VALID_SPENDING_PERIODS.has(extracted.period ?? '')
        ? (extracted.period as SpendingPeriod)
        : 'month';

      const summary = await getSpendingSummary(userId, period, now);
      // "week" is the last 7 days, not the calendar week, so the label says that.
      const label = period === 'today' ? "Today's spend" : period === 'week' ? "Last 7 days' spend" : "This month's spend";

      // "How much on food?" answers for food, not the whole breakdown.
      const category = extracted.category ? matchCategory(extracted.category) : null;
      if (category) {
        let budget;
        if (period === 'month') {
          const { getBudgetStatus } = await import('../budget/progress');
          budget = (await getBudgetStatus(userId, now)).find((status) => status.category === category);
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
