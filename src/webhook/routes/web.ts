/**
 * /api/web/* — the JSON API behind plutus-web, the Telegram Mini App where a
 * user looks at their data. Read-only for now.
 *
 * POST /session trades the Mini App's initData (validated against the bot
 * token, see src/web/init-data.ts) for a short-lived bearer token; every
 * other route needs that token and an approved user, and scopes each query to
 * them. Both secrets live only here: plutus-web never sees the bot token or
 * the database. Without either secret every route answers 503 rather than
 * running unauthenticated.
 *
 * Money goes out as integer cents with its currency, times as ISO strings;
 * plutus-web does the formatting.
 */

import { Context, Hono, Next } from 'hono';
import { VALID_CATEGORIES } from '../../expense/categorizer';
import { findTransactions, listTransactionsBetween, summarizeTransactions } from '../../expense/service';
import type { TransactionCursor } from '../../expense/service';
import { getIncomeTotal } from '../../income/service';
import { Category, Transaction } from '../../types';
import { findByChatId, findById, listUsers } from '../../users/service';
import { User } from '../../users/types';
import { monthKey, parseIsoDate, startOfDay, startOfMonth } from '../../utils/dates';
import { logger } from '../../utils/logger';
import { verifyInitData } from '../../web/init-data';
import { createSessionToken, verifySessionToken } from '../../web/session';
import { WebhookEnv } from '../types';

export interface WebApiOptions {
  botToken: string | undefined;
  sessionSecret: string | undefined;
  /** Injectable for tests. */
  now?: () => Date;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function error(c: Context, status: 400 | 401 | 403 | 404 | 503, message: string): Response {
  return c.json({ status: 'error', message }, status);
}

/** "2026-09" → the 1st of that month, local time; null for anything else. */
export function parseMonth(value: string | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value ?? '');
  if (!match) {
    return null;
  }
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? new Date(Number(match[1]), month - 1, 1) : null;
}

export function encodeCursor(row: Transaction): string {
  const cursor: TransactionCursor = { spentAt: row.spent_at.getTime(), createdAt: row.created_at.getTime(), id: row.id };
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(value: string): TransactionCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<TransactionCursor>;
    if (Number.isFinite(parsed.spentAt) && Number.isFinite(parsed.createdAt) && typeof parsed.id === 'string') {
      return parsed as TransactionCursor;
    }
  } catch {
    // fall through
  }
  return null;
}

function serializeTransaction(row: Transaction) {
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency,
    amountSgd: row.amount_sgd,
    merchant: row.merchant,
    category: row.category,
    source: row.source,
    note: row.note ?? null,
    spentAt: row.spent_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

/** What an admin sees of a user — never the encrypted LLM key or the webhook key. */
function serializeUser(user: User) {
  return {
    id: user.id,
    telegramChatId: user.telegram_chat_id,
    status: user.status,
    isAdmin: user.is_admin,
    createdAt: user.created_at.toISOString(),
  };
}

export function createWebApi(options: WebApiOptions): Hono<WebhookEnv> {
  const app = new Hono<WebhookEnv>();
  const now = options.now ?? (() => new Date());

  app.use('*', async (c, next) => {
    if (!options.botToken || !options.sessionSecret) {
      logger.error('Refusing /api/web request: TELEGRAM_BOT_TOKEN or WEB_SESSION_SECRET is not configured');
      return error(c, 503, 'The web API is not configured');
    }
    await next();
  });

  app.post('/session', async (c) => {
    const body = await c.req.json().catch(() => null);
    const initData = typeof body?.initData === 'string' ? body.initData : '';
    const verified = initData ? verifyInitData(initData, options.botToken!, now()) : null;
    if (!verified) {
      return error(c, 401, 'Invalid Telegram login');
    }

    // A private chat's id is the user's id, which is what /setup registered.
    const user = await findByChatId(verified.telegramUserId);
    if (!user || user.status !== 'approved') {
      return error(c, 403, 'This Telegram account has no approved Plutus account');
    }

    const { token, expiresAt } = createSessionToken(user.id, options.sessionSecret!, now());
    return c.json({ token, expiresAt: expiresAt.toISOString(), user: { id: user.id, isAdmin: user.is_admin } });
  });

  const requireSession = async (c: Context<WebhookEnv>, next: Next): Promise<Response | void> => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const userId = token ? verifySessionToken(token, options.sessionSecret!, now()) : null;
    if (!userId) {
      return error(c, 401, 'Unauthorized');
    }
    // Looked up on every request, so a rejected user loses access at once.
    const user = await findById(userId);
    if (!user || user.status !== 'approved') {
      return error(c, 403, 'Account is not approved');
    }
    c.set('user', user);
    await next();
  };

  app.get('/me', requireSession, (c) => {
    const user = c.get('user');
    return c.json({ id: user.id, isAdmin: user.is_admin });
  });

  app.get('/summary', requireSession, async (c) => {
    const user = c.get('user');
    const monthParam = c.req.query('month');
    const month = monthParam === undefined ? startOfMonth(now()) : parseMonth(monthParam);
    if (!month) {
      return error(c, 400, 'month must be YYYY-MM');
    }
    const start = startOfMonth(month);
    const end = startOfMonth(month, 1);

    const [rows, previousRows, incomeSgd] = await Promise.all([
      listTransactionsBetween(user.id, start, end),
      listTransactionsBetween(user.id, startOfMonth(month, -1), start),
      getIncomeTotal(user.id, start, end),
    ]);
    const summary = summarizeTransactions('month', rows);
    const byCategory = Object.entries(summary.byCategory)
      .map(([category, spentSgd]) => ({ category, spentSgd, count: summary.byCategoryCount[category] ?? 0 }))
      .sort((a, b) => b.spentSgd - a.spentSgd);

    return c.json({
      month: monthKey(start),
      from: start.toISOString(),
      to: end.toISOString(),
      spentSgd: summary.total,
      count: summary.count,
      previousMonthSpentSgd: previousRows.reduce((sum, row) => sum + row.amount_sgd, 0),
      incomeSgd,
      // Same definition as /month's savings line; null without income to divide by.
      savingsRate: incomeSgd > 0 ? (incomeSgd - summary.total) / incomeSgd : null,
      byCategory,
    });
  });

  // from/to are YYYY-MM-DD and both inclusive; q matches part of the merchant.
  app.get('/transactions', requireSession, async (c) => {
    const user = c.get('user');
    const query = c.req.query();

    const from = query.from ? parseIsoDate(query.from) : null;
    const to = query.to ? parseIsoDate(query.to) : null;
    if ((query.from && !from) || (query.to && !to)) {
      return error(c, 400, 'from and to must be YYYY-MM-DD');
    }
    let category: Category | undefined;
    if (query.category) {
      if (!VALID_CATEGORIES.includes(query.category as Category)) {
        return error(c, 400, 'Unknown category');
      }
      category = query.category as Category;
    }
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (after === null) {
      return error(c, 400, 'Invalid cursor');
    }
    const requested = Number(query.limit ?? DEFAULT_PAGE_SIZE);
    const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

    // One extra row says whether there's another page.
    const rows = await findTransactions(user.id, {
      merchant: query.q,
      category,
      from: from ? startOfDay(from) : undefined,
      to: to ? new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1) : undefined,
      after,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    return c.json({
      transactions: page.map(serializeTransaction),
      nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
    });
  });

  app.get('/admin/users', requireSession, async (c) => {
    if (!c.get('user').is_admin) {
      return error(c, 403, 'Admins only');
    }
    const users = await listUsers();
    return c.json({ users: users.map(serializeUser) });
  });

  return app;
}
