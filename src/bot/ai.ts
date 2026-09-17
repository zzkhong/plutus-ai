/**
 * Gemini-powered intent extraction and reply generation for the Telegram assistant
 */

import { getProviderForUser } from '../llm/provider';
import { findById } from '../users/service';
import { logger } from '../utils/logger';
import {
  earlierDay,
  formatDay,
  formatMonth,
  isFutureDay,
  ordinal,
  parseIsoDate,
  startOfDay,
  startOfMonth,
  toIsoDate,
} from '../utils/dates';
import { formatCurrency } from '../config/currencies';
import {
  formatCategorySpend,
  formatExpenseLine,
  formatHelpMessage,
  formatMoneyWithSgd,
  formatSpendingSummary,
  formatTransactionLabel,
  formatUserFriendlyError,
} from './formatter/messages';
import { coinPicker, editChoices, incomeActions, recentList, TransactionEdit, transactionActions } from './keyboards';
import type { FileDownloader } from './commands/split';
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
  "Stocks and ETFs come from your brokerage statements, valued at the statement's prices. Send me a statement (a screenshot, PDF or CSV) and I'll import every position.";

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
  /**
   * Which past expense a correction or search means, as the user describes
   * it — distinct from the fields above, which say what to change it *to*.
   */
  targetMerchant?: string;
  /** "YYYY-MM-DD": the day the described expense was on. */
  targetDate?: string;
  /** "YYYY-MM": the month the described expense was in ("last month"). */
  targetMonth?: string;
  /** The year an export is for. */
  year?: number;
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
  'You are Plutus AI, a personal finance assistant in Telegram. Classify each user message and return strict JSON only, with fields: intent, confidence, extracted { amount, merchant, category, period, budgetAmount, action, symbol, assetClass, currency, dayOfMonth, date, targetMerchant, targetDate, targetMonth, year }, rawText.',
  'Allowed intents: expense, income, query, find, budget, correction, recurring, holdings, portfolio, export, digest, review, undo, split, help, unknown.',
  'The expense intent covers money spent, like "Spent $4.50 at Ya Kun" or "Grab 18 yesterday" — extract amount, merchant, currency, and category as the best category for it. For a merchant people buy many kinds of things from, like Grab or Shopee, judge the category by what the message says it was for ("Grab 25 lunch" is Food, "Grab 18 to work" is Transport).',
  'The income intent covers money coming in, like "Salary $5200 came in", "got paid RM 4000" or "freelance job $800" — extract amount, currency, and merchant as what the income was (Salary, Freelance, Bonus and so on).',
  'For expense and income, extract date as YYYY-MM-DD when the user says it happened on a day other than today ("yesterday", "last Friday", "on the 3rd"); for correction, only when the user is moving the expense to another day ("that was yesterday"). Work dates and months out from the date given with the message, and leave date out otherwise.',
  'The holdings intent covers portfolio holdings mentioned in chat, like "I hold 0.5 BTC", "cash SGD 5000" or "I have 10 AAPL shares" — extract symbol (the coin, currency or ticker symbol, never a company name), assetClass (crypto, cash, or stocks_us, stocks_sg or stocks_my when it is a stock or ETF), currency, and amount as the quantity; set action="remove" when the user wants a holding removed.',
  'The recurring intent covers monthly repeating charges: adding or changing one, like "Netflix $15.98 every 5th" or "Netflix is now $17.98" — extract merchant, amount, currency, and dayOfMonth (1-31, the day of the month it recurs on); cancelling one, like "cancel my Spotify subscription" — action="remove" and merchant; or seeing them all, like "show my recurring expenses" or "what subscriptions do I have" — action="list".',
  'The query intent covers questions about how much was spent, like "how much did I spend this week" or "how much on food this month" — extract period as one of today, week, or month, and category when the question is about one category.',
  'The find intent covers seeing a list of past expenses rather than a total, like "show my Grab expenses last month", "what did I buy on 3 Sep", "list my food expenses" or "show my recent expenses" — extract targetMerchant, category, targetDate (YYYY-MM-DD) or targetMonth (YYYY-MM) for whatever narrows it down.',
  'The budget intent sets, removes or shows monthly budgets, like "Set food budget to $500" or "remove my travel budget" — extract category, budgetAmount and currency, and action="remove" for a removal; for "what are my budgets" or "how are my budgets doing", set action="list". For a budget on all spending ("monthly budget $3000", "overall budget", "total budget"), set category to Overall.',
  'The correction intent covers changing an expense already logged: the latest one ("actually that was $12", "it was in ringgit", "that was Transport", "that was yesterday") or an older one the user describes ("change my NTUC expense last Tuesday to $40", "the Grab on 3 Sep was Transport", "my Starbucks last month was in ringgit"). Extract whichever of amount, currency, merchant, category and date the user is changing it to — date being the day it should move to. When the user describes which older expense they mean, also extract that description as targetMerchant, targetDate (YYYY-MM-DD, the day it was on) and targetMonth (YYYY-MM, for "last month" or "in August"); never put the description in merchant or date, and leave the target fields out when the user means the expense just logged.',
  'The undo intent covers taking back the last thing logged, like "undo", "undo that" or "delete what I just logged".',
  'The split intent covers splitting a shared bill, like "split a bill" or "help me split dinner" — set action="last" when the user means a receipt photo they already sent, like "split this", "split that receipt" or "actually split it".',
  'The portfolio intent covers asking about investments, like "how is my portfolio doing" or "what\'s my net worth" (adding or removing a holding is the holdings intent).',
  'The export intent covers asking for their expenses as a file, like "send me my expenses as a spreadsheet", "export my data" or "CSV for 2025" — extract year when one is named.',
  'The digest intent covers asking for the daily summary, like "give me my digest" or "daily summary". The review intent covers asking how last month went, like "review last month" or "month in review".',
  'A category is one of Food, Transport, Groceries, Entertainment, Bills, Health, Education, Travel, Shopping or Others; a currency is SGD, MYR (ringgit, RM) or USD (US$) — a bare "$" means SGD, as it does in Singapore, so leave currency out for it. Use decimal numbers for money values like 4.5. Keep responses concise and practical.',
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
  /** The chat the message came from; a split opens in it. */
  chatId?: number;
  /** Fetches a Telegram file again, for splitting a receipt already logged. */
  downloadFile?: FileDownloader;
  /** Injectable for tests. */
  now?: Date;
}

type ResolvedReplyOptions = Required<Omit<ReplyOptions, 'chatId' | 'downloadFile'>> &
  Pick<ReplyOptions, 'chatId' | 'downloadFile'>;

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
    chatId: options.chatId,
    downloadFile: options.downloadFile,
    now: options.now ?? new Date(),
  });
  return typeof reply === 'string' ? { text: reply } : reply;
}

/** The `[from, to)` window a described expense's day or month gives, if any. */
function targetWindow(extracted: ExtractedFields): { from?: Date; to?: Date } {
  const day = parseIsoDate(extracted.targetDate);
  if (day) {
    return { from: startOfDay(day), to: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1) };
  }
  const month = /^(\d{4})-(\d{2})$/.exec(extracted.targetMonth ?? '');
  if (month && Number(month[2]) >= 1 && Number(month[2]) <= 12) {
    const start = new Date(Number(month[1]), Number(month[2]) - 1, 1);
    return { from: start, to: startOfMonth(start, 1) };
  }
  return {};
}

/** "at Grab in August 2026", "on 3 Sep 2026" — the description a search was for. */
function describeSearch(merchant: string | undefined, category: string | null, extracted: ExtractedFields): string {
  const parts: string[] = [];
  if (category) {
    parts.push(`under ${category}`);
  }
  if (merchant) {
    parts.push(`at ${merchant}`);
  }
  const day = parseIsoDate(extracted.targetDate);
  const window = targetWindow(extracted);
  if (day) {
    parts.push(`on ${formatDay(day)}`);
  } else if (window.from) {
    parts.push(`in ${formatMonth(window.from)}`);
  }
  return parts.join(' ');
}

/** How many matches a described expense or search shows as buttons. */
const MATCH_LIMIT = 5;

/** The edits a correction names, in the form the buttons carry them. */
function editsFrom(extracted: ExtractedFields, now: Date, matchCategory: (value: string) => string | null): TransactionEdit[] {
  const edits: TransactionEdit[] = [];
  if (extracted.currency && VALID_CURRENCIES.has(extracted.currency)) {
    edits.push({ field: 'currency', value: extracted.currency });
  }
  if (extracted.amount && extracted.amount > 0) {
    edits.push({ field: 'amount', value: String(Math.round(extracted.amount * 100) / 100) });
  }
  if (extracted.merchant) {
    edits.push({ field: 'merchant', value: extracted.merchant });
  }
  if (extracted.category) {
    // A category we know is stored as-is; anything else lets correctTransaction work one out.
    edits.push({ field: 'category', value: matchCategory(extracted.category) ?? extracted.category });
  }
  const date = parseIsoDate(extracted.date);
  if (date && !isFutureDay(date, now)) {
    edits.push({ field: 'date', value: toIsoDate(date) });
  }
  return edits;
}

async function replyForIntent(
  userId: string,
  result: IntentAnalysis,
  options: ResolvedReplyOptions,
): Promise<string | BotReply> {
  const { intent, extracted, rawText } = result;
  const { source, targetTransactionId, chatId, downloadFile, now } = options;

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

      // "What are my budgets?" gets exactly what /budget shows.
      if (extracted.action === 'list') {
        const { handleBudgetCommand } = await import('./commands/budget');
        return handleBudgetCommand(userId);
      }

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
      const { findTransactions } = await import('../expense/service');
      const { matchCategory } = await import('../expense/categorizer');
      const { applyEdits, editedReply } = await import('./handlers/edit');

      // Apply every field the message names. With nothing identifiable, ask:
      // this used to re-categorize the transaction using the whole message as
      // a hint, so "it was in ringgit" changed the category and left the
      // currency wrong.
      const edits = editsFrom(extracted, now, matchCategory);
      if (edits.length === 0) {
        return `What should I change: the amount, currency, merchant, category or date? Try "actually it was $12", "that was Transport" or "change my NTUC expense last month to $40".`;
      }

      // "Change my NTUC expense last Tuesday to $40": find the expense it
      // describes, so nobody has to scroll back to its confirmation. A reply
      // to a confirmation already says which expense, so that wins.
      const targetMerchant = extracted.targetMerchant?.trim() || undefined;
      const window = targetWindow(extracted);
      let transactionId = targetTransactionId;
      let which = targetTransactionId ? 'that expense' : 'your last expense';
      if (!targetTransactionId && (targetMerchant || window.from)) {
        const matches = await findTransactions(userId, { merchant: targetMerchant, ...window, limit: MATCH_LIMIT + 1 });
        const described = describeSearch(targetMerchant, null, extracted);
        if (matches.length === 0) {
          return `I couldn't find an expense ${described}. Try "show my expenses last month" to look through them.`;
        }
        if (matches.length > 1) {
          const entries = matches
            .slice(0, MATCH_LIMIT)
            .map((transaction) => ({ id: transaction.id, label: formatTransactionLabel(transaction) }));
          const more = matches.length > MATCH_LIMIT ? ` These are the latest ${MATCH_LIMIT}; name the day to narrow it down.` : '';
          if (edits.length === 1) {
            const choices = editChoices(entries, edits[0]);
            if (choices.carriesEdit) {
              return { text: `I found several expenses ${described}. Which one should I change?${more}`, keyboard: choices.keyboard };
            }
          }
          return {
            text: `I found several expenses ${described}. Tap the one you mean, then reply to it with the change.${more}`,
            keyboard: recentList(entries),
          };
        }
        transactionId = matches[0].id;
        which = 'that expense';
      }

      const transaction = await applyEdits(userId, transactionId, edits);
      if (!transaction) {
        return targetTransactionId
          ? `I couldn't find that expense — it may have been deleted. /recent shows what's there.`
          : `I couldn't find a recent transaction to correct. Try logging an expense first!`;
      }
      return editedReply(userId, transaction, edits, which, now);
    }
    case 'find': {
      const { findTransactions } = await import('../expense/service');
      const { matchCategory } = await import('../expense/categorizer');

      const targetMerchant = extracted.targetMerchant?.trim() || extracted.merchant?.trim() || undefined;
      const category = extracted.category ? matchCategory(extracted.category) : null;
      const window = targetWindow(extracted);
      if (!targetMerchant && !category && !window.from) {
        const { handleRecentCommand } = await import('./commands/recent');
        return handleRecentCommand(userId);
      }

      const limit = 10;
      const matches = await findTransactions(userId, {
        merchant: targetMerchant,
        category: category ?? undefined,
        ...window,
        limit: limit + 1,
      });
      const described = describeSearch(targetMerchant, category, extracted);
      if (matches.length === 0) {
        return `No expenses ${described}.`;
      }
      const shown = matches.slice(0, limit);
      const count = matches.length > limit ? `The latest ${limit} expenses` : `${shown.length === 1 ? 'One expense' : `${shown.length} expenses`}`;
      return {
        text: `${count} ${described}, newest first. Tap one to change or delete it, or reply to it with a correction.`,
        keyboard: recentList(shown.map((transaction) => ({ id: transaction.id, label: formatTransactionLabel(transaction) }))),
      };
    }
    case 'undo': {
      const { handleUndoCommand } = await import('./commands/undo');
      return handleUndoCommand(userId);
    }
    case 'split': {
      const { handleSplitCommand, splitLoggedReceipt } = await import('./commands/split');
      if (chatId === undefined) {
        return 'Say "split a bill" in the chat with me to start a split.';
      }

      // "Split this", in reply to a receipt's confirmation or right after
      // sending one: split that photo instead of asking for it again.
      let receiptId = targetTransactionId;
      if (!receiptId && extracted.action === 'last') {
        const { listRecentTransactions } = await import('../expense/service');
        const [latest] = await listRecentTransactions(userId, 1);
        receiptId = latest?.photo_file_id ? latest.id : null;
      }
      if (receiptId && downloadFile) {
        return splitLoggedReceipt(chatId, userId, receiptId, downloadFile);
      }
      return handleSplitCommand(chatId);
    }
    case 'export': {
      const { exportCSV } = await import('../expense/service');
      const thisYear = now.getFullYear();
      const year = extracted.year && extracted.year >= 2000 && extracted.year <= thisYear ? extracted.year : thisYear;
      const csv = await exportCSV(userId, year);
      if (csv.rowCount === 0) {
        return `Nothing to export — no expenses logged in ${year}.`;
      }
      return {
        text: `${csv.rowCount} expense${csv.rowCount === 1 ? '' : 's'} from ${year}.`,
        document: { filename: csv.filename, content: csv.content },
      };
    }
    case 'portfolio': {
      const { handlePortfolioCommand } = await import('./commands/portfolio');
      return handlePortfolioCommand(userId);
    }
    case 'digest': {
      const { handleDigestCommand } = await import('./commands/digest');
      return handleDigestCommand(userId);
    }
    case 'review': {
      const { handleReviewCommand } = await import('./commands/review');
      return handleReviewCommand(userId, now);
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
