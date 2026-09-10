/**
 * Gemini-powered intent extraction and reply generation for the Telegram assistant
 */

import { getProviderForUser } from '../llm/provider';
import { findById } from '../users/service';
import { logger } from '../utils/logger';
import { formatUserFriendlyError } from './formatter/messages';
import { BotIntent } from './types';
import { AssetClass, Currency } from '../types';
import { ExpenseSource, SpendingPeriod } from '../expense/types';

const VALID_HOLDINGS_ASSET_CLASSES = new Set(['crypto', 'cash']);
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
        'You are Pluto AI, a personal finance assistant in Telegram. Classify each user message and return strict JSON only. Return fields: intent, confidence, extracted { amount, merchant, category, period, budgetAmount, action, symbol, assetClass, currency, dayOfMonth }, rawText. Allowed intents: expense, query, budget, correction, recurring, holdings, help, unknown. The holdings intent covers non-brokerage portfolio updates like "I hold 0.5 BTC" or "cash SGD 5000" — extract symbol (e.g. BTC, SGD), assetClass (crypto or cash), currency, and amount as the quantity. The recurring intent covers repeating charges like "Netflix $15.98 every 5th" or "cancel my Spotify subscription" — extract merchant, amount, and dayOfMonth (1-31, the day of the month it recurs on) for a new one, or action="remove" and merchant for cancelling an existing one. The query intent covers spending questions like "how much did I spend this week" — extract period as one of today, week, or month. Use decimal numbers for money values like 4.5. Keep responses concise and practical.',
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

      const transaction = await logExpense({
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
        await removeBudget(category);
        return `Done — removed the ${category} budget.`;
      }

      const amount = extracted.budgetAmount ?? extracted.amount ?? 0;
      if (amount <= 0) {
        return `What amount should the ${category} budget be? Try "Set food budget to $800/month".`;
      }

      const budget = await setBudget(category, amount);
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

      const corrected = await correctLastTransaction(field, value);

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
        const all = await listRecurring();
        const match = all.find((r) => r.merchant.toLowerCase() === extracted.merchant!.toLowerCase());

        if (!match) {
          return `I couldn't find a recurring entry for "${extracted.merchant}".`;
        }

        await removeRecurring(match.id);
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

      const recurring = await createRecurring({
        amount,
        currency,
        merchant: extracted.merchant,
        day_of_month: dayOfMonth,
      });

      return `Got it — I'll log $${amount.toFixed(2)} at ${recurring.merchant} every month on day ${recurring.day_of_month}.`;
    }
    case 'holdings': {
      const { addHolding, removeHolding } = await import('../portfolio/service');

      if (!extracted.symbol) {
        return `Which holding? Try "I hold 0.5 BTC" or "cash SGD 5000".`;
      }

      const symbol = extracted.symbol.toUpperCase();
      const isRemoval = /remove|delete/i.test(extracted.action ?? rawText);

      if (isRemoval) {
        await removeHolding(symbol);
        return `Done — removed ${symbol} from your holdings.`;
      }

      const quantity = extracted.amount ?? 0;
      if (quantity <= 0) {
        return `How much ${symbol} do you hold?`;
      }

      const assetClass: AssetClass = VALID_HOLDINGS_ASSET_CLASSES.has(extracted.assetClass ?? '')
        ? (extracted.assetClass as AssetClass)
        : 'crypto';
      const currency: Currency = VALID_CURRENCIES.has(extracted.currency ?? '')
        ? (extracted.currency as Currency)
        : 'USD';

      const holding = await addHolding({
        symbol,
        name: symbol,
        quantity,
        asset_class: assetClass,
        currency,
        market: assetClass === 'cash' ? 'Cash' : 'Crypto',
      });

      return `Got it — recorded ${holding.quantity} ${holding.symbol}.`;
    }
    case 'query': {
      const { getSpendingSummary } = await import('../expense/service');
      const { formatSpendingSummary } = await import('./formatter/messages');

      const period: SpendingPeriod = VALID_SPENDING_PERIODS.has(extracted.period ?? '')
        ? (extracted.period as SpendingPeriod)
        : 'month';

      const summary = await getSpendingSummary(period);
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
