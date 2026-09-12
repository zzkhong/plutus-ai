/**
 * Reads a brokerage statement into holdings with the user's own LLM provider.
 *
 * Deliberately generic: any broker, any layout, and any file the provider can
 * read — a PDF statement, a screenshot of a positions screen, or a CSV/text
 * export. There is no per-broker parser; the model is asked to read the file
 * the way a person would. Its output is then validated strictly here, and
 * any failure surfaces as StatementParseError rather than a guess.
 *
 * Stocks are valued at the prices the statement gives (there are no live
 * stock quotes), so each position's per-unit price and the statement date
 * are extracted as well.
 */

import type { ContentPart } from '../llm/provider';
import { getProviderForUser } from '../llm/provider';
import { findById } from '../users/service';
import { AssetClass, Currency } from '../types';
import { ParsedHolding, ParsedStatement, SkippedPosition } from './types';

export class StatementParseError extends Error {}

/** The file was read, but isn't an investment statement — perhaps a receipt sent as a file. */
export class NotAStatementError extends StatementParseError {}

export type StatementFileKind = 'pdf' | 'image' | 'text';

export interface StatementFile {
  data: Buffer;
  kind: StatementFileKind;
  mimeType: string;
}

const STOCK_ASSET_CLASSES = new Set<string>(['stocks_us', 'stocks_sg', 'stocks_my']);
const SUPPORTED_CURRENCIES = new Set<string>(['SGD', 'MYR', 'USD']);

// Far longer than any real positions export.
const MAX_TEXT_CHARS = 200_000;

// Reading a multi-page PDF or an image takes much longer than a short text
// prompt. This stays well inside Vercel's function time limit.
const PARSE_TIMEOUT_MS = 90_000;

const SYSTEM_INSTRUCTION = `You read brokerage and investment statements for Plutus AI, a personal finance assistant. The file can come from any broker or platform and be laid out any way: a PDF statement, a screenshot of a positions screen, or a CSV or text export. Read it the way a person would and find the positions the account holds, wherever and however the file lists them. Do not assume any particular section names, column order or broker.

Return strict JSON only, in exactly this shape:
{"broker": string | null, "statement_date": "YYYY-MM-DD" | null, "holdings": [{"symbol": string, "name": string, "quantity": number, "price": number | null, "market_value": number | null, "currency": string, "asset_class": "stocks_us" | "stocks_sg" | "stocks_my" | "other", "market": string | null}]}

- broker: the broker's short common name in lowercase, such as "ibkr" for Interactive Brokers, "moomoo", "tiger", "saxo", "fsmone" or "syfe". Use the same name every time for the same broker, because a newer statement replaces the older one's holdings.
- statement_date: the date the positions are valued at.
- symbol: the exchange ticker code, never the company name, without an exchange suffix: for example AAPL, an SGX code such as D05, or a Bursa code such as 1155.
- quantity: the units held at the statement date.
- price: the closing or market price per unit shown for that date, in the position's currency. market_value: the position's total value, if shown. Give whichever the file shows, or both.
- currency: the ISO 4217 code of the currency the position is priced in.
- asset_class: stocks_us for stocks and ETFs listed in the US, stocks_sg for SGX, stocks_my for Bursa Malaysia, and other for anything else (bonds, unit trusts, other exchanges).
- Leave out cash balances, dividend accruals, options and futures.
- Write numbers as plain numbers, without thousands separators or currency symbols.

If the file is not an investment statement or shows no positions, return {"broker": null, "statement_date": null, "holdings": []}.`;

/**
 * Importing a statement replaces every holding with the same broker value, so
 * the name must come out the same each time. The model is asked for a short
 * name; this also folds case, spacing, punctuation and a few long forms
 * together so "Interactive Brokers LLC" and "ibkr" don't become two sources.
 */
const BROKER_ALIASES: Record<string, string> = {
  interactivebrokers: 'ibkr',
  interactivebrokersllc: 'ibkr',
  ib: 'ibkr',
  futu: 'moomoo',
  futubull: 'moomoo',
  moomoofinancial: 'moomoo',
  tigerbrokers: 'tiger',
  tigertrade: 'tiger',
};

export function normalizeBroker(raw: string): string {
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  return BROKER_ALIASES[key] ?? key;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[,\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseStatementDate(value: unknown, now: Date): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return now;
  }
  const date = new Date(`${value}T00:00:00`);
  // A statement can't be dated after it was uploaded; treat that as a misread.
  return Number.isNaN(date.getTime()) || date.getTime() > now.getTime() ? now : date;
}

export function parseStatementResponse(rawText: string, now: Date = new Date()): ParsedStatement {
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new StatementParseError('the statement reader returned something that is not JSON');
  }

  let parsed: { broker?: unknown; statement_date?: unknown; holdings?: unknown };
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    throw new StatementParseError('the statement reader returned invalid JSON');
  }

  const rawHoldings = Array.isArray(parsed.holdings) ? (parsed.holdings as unknown[]) : [];
  const broker = typeof parsed.broker === 'string' ? normalizeBroker(parsed.broker) : '';
  if (!broker || rawHoldings.length === 0) {
    throw new NotAStatementError("it doesn't look like an investment statement with positions in it");
  }

  const holdings: ParsedHolding[] = [];
  const skipped: SkippedPosition[] = [];

  rawHoldings.forEach((raw, index) => {
    const position = (raw ?? {}) as Record<string, unknown>;

    const symbol = typeof position.symbol === 'string' ? position.symbol.trim().toUpperCase() : '';
    if (!symbol) {
      throw new StatementParseError(`position ${index + 1} has no symbol`);
    }

    const quantity = toNumber(position.quantity);
    if (quantity === null || quantity <= 0) {
      throw new StatementParseError(`${symbol} has an invalid quantity`);
    }

    const currency = typeof position.currency === 'string' ? position.currency.trim().toUpperCase() : '';
    if (!SUPPORTED_CURRENCIES.has(currency)) {
      skipped.push({ symbol, reason: currency ? `priced in ${currency}` : 'no currency shown' });
      return;
    }

    const assetClass = typeof position.asset_class === 'string' ? position.asset_class : '';
    if (!STOCK_ASSET_CLASSES.has(assetClass)) {
      skipped.push({ symbol, reason: 'not a US, SGX or Bursa listing' });
      return;
    }

    const price = toNumber(position.price);
    const marketValue = toNumber(position.market_value);
    const unitPrice =
      price !== null && price > 0 ? price : marketValue !== null && marketValue > 0 ? marketValue / quantity : null;
    if (unitPrice === null) {
      skipped.push({ symbol, reason: 'no price on the statement' });
      return;
    }

    const name = typeof position.name === 'string' && position.name.trim() ? position.name.trim() : symbol;
    const market = typeof position.market === 'string' ? position.market.trim() : '';

    holdings.push({
      symbol,
      name,
      quantity,
      price: unitPrice,
      currency: currency as Currency,
      asset_class: assetClass as AssetClass,
      market,
    });
  });

  if (holdings.length === 0) {
    const reasons = skipped.map((s) => `${s.symbol}: ${s.reason}`).join(', ');
    throw new StatementParseError(`none of its positions can be valued here (${reasons})`);
  }

  return { broker, as_of: parseStatementDate(parsed.statement_date, now), holdings, skipped };
}

function contentFor(file: StatementFile): ContentPart[] {
  if (file.kind === 'text') {
    const text = file.data.toString('utf8').slice(0, MAX_TEXT_CHARS);
    return [{ text: `Here are the statement file's contents:\n\n${text}` }];
  }
  return [
    { inlineData: { mimeType: file.mimeType, data: file.data.toString('base64') } },
    { text: 'Extract the positions from this statement.' },
  ];
}

export async function parseStatement(userId: string, file: StatementFile): Promise<ParsedStatement> {
  let responseText: string;
  try {
    const user = await findById(userId);
    if (!user) {
      throw new StatementParseError(`no user found with id ${userId}`);
    }
    const provider = getProviderForUser(user);

    responseText = await provider.generateText({
      systemInstruction: SYSTEM_INSTRUCTION,
      contents: contentFor(file),
      timeoutMs: PARSE_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof StatementParseError) {
      throw error;
    }
    throw new StatementParseError(`the statement reader failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return parseStatementResponse(responseText);
}
