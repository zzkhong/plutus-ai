# Portfolio Tracker (PLUTO-04) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track the user's investment portfolio (US stocks via IBKR, SG/MY/US stocks via Moomoo, crypto, cash) and surface net worth in SGD, allocation by asset class/currency, and daily movement via `/portfolio`. Brokerage holdings come from uploading a statement PDF; crypto/cash come from chat.

**Architecture:** A new `src/portfolio/` module: Drizzle-based CRUD (`service.ts`) against the existing `holdings` table (plus one new `broker` column), a Gemini-multimodal PDF parser (`statement-parser.ts`) that identifies IBKR vs Moomoo and extracts positions, a unified price fetcher (`price-fetcher/`) hitting Yahoo Finance (US/MY/SG stocks) and CoinGecko (crypto) with an in-memory TTL cache, and pure allocation math (`calculator.ts`). A new Telegram `message:document` handler drives PDF uploads; a new `holdings` chat intent (wired the same dynamic-import way as the existing `budget`/`correction` intents) drives crypto/cash.

**Tech Stack:** TypeScript, Drizzle ORM (`drizzle-orm/better-sqlite3`), `@google/generative-ai` (multimodal), grammy, node:test.

**Spec:** [docs/superpowers/specs/2026-08-31-portfolio-tracker-design.md](../specs/2026-08-31-portfolio-tracker-design.md)

## Global Constraints

- All monetary amounts are stored/returned as integer SGD cents (`value_sgd`, `net_worth_sgd`), never floats. `quantity` itself stays a real number (matches the existing `holdings.quantity: real` column).
- `AssetClass` (`src/types/portfolio.ts`) is `'stocks_us' | 'stocks_my' | 'stocks_sg' | 'crypto' | 'cash'` — this plan adds `'stocks_sg'`; no other new asset classes.
- Brokerage holdings (`broker` set to `'ibkr'` or `'moomoo'`) are only ever written by `replaceHoldingsForBroker`. Manually-entered holdings (`broker: null`) are only ever written by `addHolding`/`removeHolding`. The two paths never touch each other's rows.
- No `price_cache` DB table. Prices are cached in-memory only, mirroring the existing pattern in `src/config/exchange-rates.ts`.
- Price fetchers (`price-fetcher/stocks.ts`, `price-fetcher/crypto.ts`) return `null` on any failure (network, bad response shape, unmapped symbol) — they never throw. Only `statement-parser.ts` throws (`StatementParseError`), matching `classifyUserMessage`'s degrade-vs-guess convention for the one Gemini-first path in this module.
- The portfolio module uses the Drizzle query builder (`db` from `src/db/client.ts`), not the expense module's raw-`better-sqlite3` pattern — same choice already made for the budget module.
- New test files must be added to the `test` script in `package.json` or they will not run under `npm test`.
- Test files that touch the database must set `process.env.DATABASE_URL` to a dedicated, non-shared test db path *before* importing anything that transitively loads `src/config/env.ts`, delete any stale file at that path, then call `runMigrations()` from `src/db/migrate.ts` in a `before()` hook — the existing pattern in `src/expense/expense.test.ts` and `src/budget/service.test.ts`.
- The statement-parsing prompt has not been validated against real IBKR/Moomoo PDFs (none were available at plan-writing time) — this is a known, explicitly out-of-scope gap per the spec. Do not treat its extraction success path as fully tested; only its JSON-mapping and failure-degradation logic are.

---

## File Structure

```
src/db/schema.ts                             # modify: add `broker` column to `holdings`
src/db/migrations/                           # generated: new migration for `holdings.broker`
src/types/portfolio.ts                       # modify: AssetClass gains 'stocks_sg'

src/portfolio/
├── types.ts                                 # create: Broker, Holding, HoldingInput, ParsedHolding, ParsedStatement, PriceQuote, EnrichedHolding, AllocationEntry, PortfolioSummary
├── service.ts                                # create: addHolding, removeHolding, replaceHoldingsForBroker, listHoldings
├── service.test.ts                           # create
├── calculator.ts                             # create: enrichHolding, calculateNetWorth, calculateAllocation, buildPortfolioSummary
├── calculator.test.ts                        # create
├── statement-parser.ts                       # create: parseStatement, parseGeminiStatementResponse, StatementParseError
├── statement-parser.test.ts                  # create
├── index.ts                                  # create: public exports + getPortfolioSummary orchestration
└── price-fetcher/
    ├── crypto.ts                             # create: getCryptoPrice
    ├── crypto.test.ts                        # create
    ├── symbol-map.ts                         # create: SYMBOL_MAP, resolveYahooSymbol
    ├── stocks.ts                             # create: getStockPrice
    ├── stocks.test.ts                        # create
    ├── index.ts                              # create: getPrice (unified + in-memory TTL cache)
    └── index.test.ts                         # create

src/bot/commands/portfolio.ts                # modify: real /portfolio command
src/bot/handlers/document.ts                 # create: handleDocumentMessage
src/bot/handlers/document.test.ts            # create
src/bot/index.ts                             # modify: wire message:document handler
src/bot/types.ts                             # modify: BotIntent gains 'holdings'
src/bot/ai.ts                                # modify: ExtractedFields gains symbol/assetClass/currency; wire 'holdings' intent
src/bot/ai.test.ts                           # modify: add tests for the 'holdings' intent

package.json                                 # modify: register new test files
docs/tasks/04-portfolio-tracker.md           # modify: check off implemented acceptance criteria
```

---

### Task 1: Schema — add `broker` column, extend `AssetClass`

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/types/portfolio.ts`
- Generated: `src/db/migrations/*.sql` (new file, exact name assigned by drizzle-kit), `src/db/migrations/meta/*`

**Interfaces:**
- Produces: `holdings.broker` column (nullable text), importable via the existing `import { holdings } from '../db/schema'`. `AssetClass` gains `'stocks_sg'`.

- [ ] **Step 1: Add the column to the schema**

In `src/db/schema.ts`, in the existing `holdings` table definition, add a `broker` column immediately after `market`:

```typescript
// Holdings (portfolio) table
export const holdings = sqliteTable('holdings', {
  id: text('id').primaryKey(),
  symbol: text('symbol').notNull(),
  name: text('name').notNull(),
  asset_class: text('asset_class').notNull(),
  quantity: real('quantity').notNull(),
  currency: text('currency').notNull(),
  market: text('market').notNull(),
  broker: text('broker'), // 'ibkr' | 'moomoo' | null (null = manually entered: crypto/cash)
  cost_basis: integer('cost_basis'), // optional, in cents
  created_at: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updated_at: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});
```

- [ ] **Step 2: Extend `AssetClass`**

In `src/types/portfolio.ts`, change:

```typescript
export type AssetClass = 'stocks_us' | 'stocks_my' | 'crypto' | 'cash';
```

to:

```typescript
export type AssetClass = 'stocks_us' | 'stocks_my' | 'stocks_sg' | 'crypto' | 'cash';
```

- [ ] **Step 3: Generate the migration**

Run: `npm run db:generate`

Expected: a new file appears under `src/db/migrations/` (e.g. `0003_<name>.sql`) containing `ALTER TABLE holdings ADD COLUMN broker text;`, and `src/db/migrations/meta/_journal.json` gains a new entry.

- [ ] **Step 4: Verify migrations apply cleanly**

Run: `npx tsx -e "import('./src/db/migrate').then(m => m.runMigrations())"`

Expected: logs "Migrations completed successfully!" with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/types/portfolio.ts src/db/migrations
git commit -m "feat(db): add holdings.broker column and stocks_sg asset class"
```

---

### Task 2: Portfolio types and CRUD service

**Files:**
- Create: `src/portfolio/types.ts`
- Create: `src/portfolio/service.ts`
- Create: `src/portfolio/service.test.ts`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `db` from `../db` (Drizzle instance), `holdings` table from `../db` (Task 1), `AssetClass`/`Currency` from `../types` (existing/Task 1).
- Produces:
  - `type Broker = 'ibkr' | 'moomoo'`
  - `interface Holding { id, symbol, name, asset_class, quantity, currency, market, broker: Broker | null, cost_basis?, created_at, updated_at }`
  - `interface HoldingInput { symbol, name, quantity, asset_class, currency, market }`
  - `interface ParsedHolding { symbol, name, quantity, asset_class, currency, market }` (no `id`/`broker`/timestamps — pre-persistence shape)
  - `interface ParsedStatement { broker: Broker; holdings: ParsedHolding[] }`
  - `interface PriceQuote { price: number; currency: Currency; change_pct: number; as_of: Date }`
  - `interface EnrichedHolding extends Holding { quote: PriceQuote | null; value_sgd: number }`
  - `interface AllocationEntry { key: string; value_sgd: number; pct: number }`
  - `interface PortfolioSummary { net_worth_sgd: number; by_class: AllocationEntry[]; by_currency: AllocationEntry[]; holdings: EnrichedHolding[] }`
  - `addHolding(input: HoldingInput): Promise<Holding>`
  - `removeHolding(symbol: string): Promise<void>`
  - `replaceHoldingsForBroker(broker: Broker, parsed: ParsedHolding[]): Promise<Holding[]>`
  - `listHoldings(): Promise<Holding[]>`

- [ ] **Step 1: Write `types.ts`**

```typescript
/**
 * Portfolio module types
 */

import { AssetClass, Currency } from '../types';

export type Broker = 'ibkr' | 'moomoo';

export interface Holding {
  id: string;
  symbol: string;
  name: string;
  asset_class: AssetClass;
  quantity: number;
  currency: Currency;
  market: string;
  broker: Broker | null; // null = manually entered (crypto/cash)
  cost_basis?: number;
  created_at: Date;
  updated_at: Date;
}

export interface HoldingInput {
  symbol: string;
  name: string;
  quantity: number;
  asset_class: AssetClass;
  currency: Currency;
  market: string;
}

export interface ParsedHolding {
  symbol: string;
  name: string;
  quantity: number;
  asset_class: AssetClass; // 'stocks_us' | 'stocks_my' | 'stocks_sg'
  currency: Currency;
  market: string;
}

export interface ParsedStatement {
  broker: Broker;
  holdings: ParsedHolding[];
}

export interface PriceQuote {
  price: number; // in quote currency, not cents
  currency: Currency;
  change_pct: number; // vs previous close / 24h
  as_of: Date;
}

export interface EnrichedHolding extends Holding {
  quote: PriceQuote | null;
  value_sgd: number; // cents
}

export interface AllocationEntry {
  key: string; // asset class or currency value
  value_sgd: number;
  pct: number;
}

export interface PortfolioSummary {
  net_worth_sgd: number;
  by_class: AllocationEntry[];
  by_currency: AllocationEntry[];
  holdings: EnrichedHolding[];
}
```

- [ ] **Step 2: Write the failing test**

Create `src/portfolio/service.test.ts`:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-portfolio-service.db';

const testDbPath = path.resolve('./data/test-portfolio-service.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
});

test('addHolding creates a new manual holding with broker null', async () => {
  const { addHolding } = await import('./service');
  const holding = await addHolding({
    symbol: 'BTC',
    name: 'Bitcoin',
    quantity: 0.5,
    asset_class: 'crypto',
    currency: 'USD',
    market: 'Crypto',
  });

  assert.equal(holding.symbol, 'BTC');
  assert.equal(holding.quantity, 0.5);
  assert.equal(holding.broker, null);
});

test('addHolding updates the existing manual holding for the same symbol instead of duplicating', async () => {
  const { addHolding, listHoldings } = await import('./service');
  await addHolding({ symbol: 'ETH', name: 'Ethereum', quantity: 1, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });
  await addHolding({ symbol: 'ETH', name: 'Ethereum', quantity: 2, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });

  const all = await listHoldings();
  const ethHoldings = all.filter((h) => h.symbol === 'ETH');

  assert.equal(ethHoldings.length, 1);
  assert.equal(ethHoldings[0].quantity, 2);
});

test('removeHolding deletes only the manual holding with that symbol', async () => {
  const { addHolding, removeHolding, listHoldings } = await import('./service');
  await addHolding({ symbol: 'DOGE', name: 'Dogecoin', quantity: 100, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });
  await removeHolding('DOGE');

  const all = await listHoldings();
  assert.ok(!all.some((h) => h.symbol === 'DOGE'));
});

test('replaceHoldingsForBroker inserts fresh holdings tagged with that broker', async () => {
  const { replaceHoldingsForBroker } = await import('./service');
  const inserted = await replaceHoldingsForBroker('ibkr', [
    { symbol: 'AAPL', name: 'Apple Inc.', quantity: 10, asset_class: 'stocks_us', currency: 'USD', market: 'NASDAQ' },
  ]);

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].broker, 'ibkr');
  assert.equal(inserted[0].symbol, 'AAPL');
});

test('replaceHoldingsForBroker wipes only the target broker\'s rows, leaving other brokers and manual entries untouched', async () => {
  const { replaceHoldingsForBroker, addHolding, listHoldings } = await import('./service');

  await replaceHoldingsForBroker('ibkr', [
    { symbol: 'MSFT', name: 'Microsoft', quantity: 5, asset_class: 'stocks_us', currency: 'USD', market: 'NASDAQ' },
  ]);
  await replaceHoldingsForBroker('moomoo', [
    { symbol: 'SIA', name: 'Singapore Airlines', quantity: 100, asset_class: 'stocks_sg', currency: 'SGD', market: 'SGX' },
  ]);
  await addHolding({ symbol: 'BNB', name: 'Binance Coin', quantity: 3, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });

  // Re-upload a new IBKR statement with a different position.
  await replaceHoldingsForBroker('ibkr', [
    { symbol: 'GOOG', name: 'Alphabet', quantity: 2, asset_class: 'stocks_us', currency: 'USD', market: 'NASDAQ' },
  ]);

  const all = await listHoldings();
  assert.ok(!all.some((h) => h.symbol === 'MSFT'), 'old IBKR position should be gone');
  assert.ok(all.some((h) => h.symbol === 'GOOG'), 'new IBKR position should be present');
  assert.ok(all.some((h) => h.symbol === 'SIA'), 'moomoo holding should be untouched');
  assert.ok(all.some((h) => h.symbol === 'BNB'), 'manual holding should be untouched');
});

test('replaceHoldingsForBroker rejects an empty holdings list', async () => {
  const { replaceHoldingsForBroker } = await import('./service');
  await assert.rejects(() => replaceHoldingsForBroker('ibkr', []));
});
```

- [ ] **Step 3: Register the test file and run it to see it fail**

In `package.json`, update the `test` script to:

```json
"test": "npx tsx --test src/bot/ai.test.ts src/expense/expense.test.ts src/budget/service.test.ts src/budget/progress.test.ts src/budget/alerts.test.ts src/scheduler/recurring.test.ts src/digest/digest.test.ts src/webhook/webhook.test.ts src/portfolio/service.test.ts",
```

Run: `npx tsx --test src/portfolio/service.test.ts`
Expected: FAIL — `Cannot find module './service'`.

- [ ] **Step 4: Write `service.ts`**

```typescript
/**
 * Portfolio holdings CRUD service (Drizzle-backed).
 */

import { randomUUID } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { holdings } from '../db/schema';
import { AssetClass, Currency } from '../types';
import { Broker, Holding, HoldingInput, ParsedHolding } from './types';

function mapHoldingRow(row: typeof holdings.$inferSelect): Holding {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    asset_class: row.asset_class as AssetClass,
    quantity: row.quantity,
    currency: row.currency as Currency,
    market: row.market,
    broker: (row.broker as Broker | null) ?? null,
    cost_basis: row.cost_basis ?? undefined,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

/** Manual (crypto/cash) holdings only — never touches broker-sourced rows. */
export async function addHolding(input: HoldingInput): Promise<Holding> {
  const now = Date.now();
  const existing = await db
    .select()
    .from(holdings)
    .where(and(eq(holdings.symbol, input.symbol), isNull(holdings.broker)))
    .get();

  if (existing) {
    const [updated] = await db
      .update(holdings)
      .set({
        name: input.name,
        asset_class: input.asset_class,
        quantity: input.quantity,
        currency: input.currency,
        market: input.market,
        updated_at: now,
      })
      .where(eq(holdings.id, existing.id))
      .returning();
    return mapHoldingRow(updated);
  }

  const [inserted] = await db
    .insert(holdings)
    .values({
      id: randomUUID(),
      symbol: input.symbol,
      name: input.name,
      asset_class: input.asset_class,
      quantity: input.quantity,
      currency: input.currency,
      market: input.market,
      broker: null,
      created_at: now,
      updated_at: now,
    })
    .returning();

  return mapHoldingRow(inserted);
}

/** Manual (crypto/cash) holdings only — never touches broker-sourced rows. */
export async function removeHolding(symbol: string): Promise<void> {
  await db.delete(holdings).where(and(eq(holdings.symbol, symbol), isNull(holdings.broker)));
}

/**
 * Full snapshot replace, scoped to one broker: wipes all existing holdings
 * for that broker and inserts the statement's ending positions. Never
 * touches the other broker's rows or manually-entered holdings.
 */
export async function replaceHoldingsForBroker(broker: Broker, parsed: ParsedHolding[]): Promise<Holding[]> {
  if (parsed.length === 0) {
    throw new Error(
      'Refusing to replace holdings with an empty list — an empty statement is almost always a parse failure, not an emptied account.',
    );
  }

  const now = Date.now();
  await db.delete(holdings).where(eq(holdings.broker, broker));

  const rows = parsed.map((h) => ({
    id: randomUUID(),
    symbol: h.symbol,
    name: h.name,
    asset_class: h.asset_class,
    quantity: h.quantity,
    currency: h.currency,
    market: h.market,
    broker,
    created_at: now,
    updated_at: now,
  }));

  const inserted = await db.insert(holdings).values(rows).returning();
  return inserted.map(mapHoldingRow);
}

export async function listHoldings(): Promise<Holding[]> {
  const rows = await db.select().from(holdings).orderBy(holdings.symbol);
  return rows.map(mapHoldingRow);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test src/portfolio/service.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/portfolio/types.ts src/portfolio/service.ts src/portfolio/service.test.ts package.json
git commit -m "feat(portfolio): add holdings types and CRUD service"
```

---

### Task 3: Crypto price fetcher (CoinGecko)

**Files:**
- Create: `src/portfolio/price-fetcher/crypto.ts`
- Create: `src/portfolio/price-fetcher/crypto.test.ts`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `PriceQuote` from `../types` (Task 2).
- Produces: `getCryptoPrice(symbol: 'BTC' | 'ETH' | 'BETH'): Promise<PriceQuote | null>`

- [ ] **Step 1: Write the failing test**

Create `src/portfolio/price-fetcher/crypto.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

test('getCryptoPrice returns price and 24h change on a successful call', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = (async (url: string) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => ({ bitcoin: { usd: 65000, usd_24h_change: 2.5 } }),
    };
  }) as typeof fetch;

  try {
    const { getCryptoPrice } = await import('./crypto');
    const quote = await getCryptoPrice('BTC');

    assert.ok(quote);
    assert.equal(quote!.price, 65000);
    assert.equal(quote!.currency, 'USD');
    assert.equal(quote!.change_pct, 2.5);
    assert.match(requestedUrl, /ids=bitcoin/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getCryptoPrice uses the binance-staked-eth id for BETH', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = (async (url: string) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ 'binance-staked-eth': { usd: 3000, usd_24h_change: -1 } }) };
  }) as typeof fetch;

  try {
    const { getCryptoPrice } = await import('./crypto');
    const quote = await getCryptoPrice('BETH');
    assert.ok(quote);
    assert.equal(quote!.price, 3000);
    assert.match(requestedUrl, /ids=binance-staked-eth/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getCryptoPrice returns null when the response is not ok', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => ({ ok: false, json: async () => ({}) })) as typeof fetch;

  try {
    const { getCryptoPrice } = await import('./crypto');
    const quote = await getCryptoPrice('ETH');
    assert.equal(quote, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getCryptoPrice returns null when fetch throws', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { getCryptoPrice } = await import('./crypto');
    const quote = await getCryptoPrice('BTC');
    assert.equal(quote, null);
  } finally {
    global.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Register the test file and run it to see it fail**

In `package.json`, append `src/portfolio/price-fetcher/crypto.test.ts` to the `test` script.

Run: `npx tsx --test src/portfolio/price-fetcher/crypto.test.ts`
Expected: FAIL — `Cannot find module './crypto'`.

- [ ] **Step 3: Write `crypto.ts`**

```typescript
/**
 * Crypto price fetching via CoinGecko's free API.
 */

import { Currency } from '../../types';
import { PriceQuote } from '../types';

const COINGECKO_IDS: Record<'BTC' | 'ETH' | 'BETH', string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  BETH: 'binance-staked-eth',
};

export async function getCryptoPrice(symbol: 'BTC' | 'ETH' | 'BETH'): Promise<PriceQuote | null> {
  const id = COINGECKO_IDS[symbol];
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const entry = data[id];
    if (!entry || typeof entry.usd !== 'number') {
      return null;
    }

    return {
      price: entry.usd,
      currency: 'USD' as Currency,
      change_pct: typeof entry.usd_24h_change === 'number' ? entry.usd_24h_change : 0,
      as_of: new Date(),
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/portfolio/price-fetcher/crypto.test.ts`
Expected: PASS, all 4 tests green.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/portfolio/price-fetcher/crypto.ts src/portfolio/price-fetcher/crypto.test.ts package.json
git commit -m "feat(portfolio): add CoinGecko crypto price fetcher"
```

---

### Task 4: Stock price fetcher (Yahoo Finance) and MY/SG symbol map

**Files:**
- Create: `src/portfolio/price-fetcher/symbol-map.ts`
- Create: `src/portfolio/price-fetcher/stocks.ts`
- Create: `src/portfolio/price-fetcher/stocks.test.ts`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `AssetClass`, `Currency` from `../../types` (existing/Task 1), `PriceQuote` from `../types` (Task 2).
- Produces:
  - `resolveYahooSymbol(statementSymbol: string): string | null`
  - `getStockPrice(symbol: string, assetClass: AssetClass, currency: Currency): Promise<PriceQuote | null>`

- [ ] **Step 1: Write `symbol-map.ts`**

```typescript
/**
 * Manual mapping from a broker statement's reported symbol to the Yahoo
 * Finance chart-API symbol, for MY (Bursa, `.KL`) and SG (SGX, `.SI`)
 * stocks. A Moomoo statement reports a stock by name or local code, which
 * won't reliably match Yahoo's numeric/ticker symbol — fill in an entry
 * here whenever a new MY/SG holding is added. An unmapped symbol degrades
 * to "price unavailable" rather than guessing.
 */
export const SYMBOL_MAP: Record<string, string> = {
  // e.g. 'MAYBANK': '1155.KL', 'SIA': 'C6L.SI'
};

export function resolveYahooSymbol(statementSymbol: string): string | null {
  return SYMBOL_MAP[statementSymbol] ?? null;
}
```

- [ ] **Step 2: Write the failing test**

Create `src/portfolio/price-fetcher/stocks.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

test('getStockPrice fetches a US symbol directly from Yahoo', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = (async (url: string) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => ({
        chart: { result: [{ meta: { regularMarketPrice: 190, chartPreviousClose: 180 } }] },
      }),
    };
  }) as typeof fetch;

  try {
    const { getStockPrice } = await import('./stocks');
    const quote = await getStockPrice('AAPL', 'stocks_us', 'USD');

    assert.ok(quote);
    assert.equal(quote!.price, 190);
    assert.equal(quote!.currency, 'USD');
    assert.ok(Math.abs(quote!.change_pct - 5.5556) < 0.01);
    assert.match(requestedUrl, /chart\/AAPL$/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getStockPrice resolves a mapped MY symbol to its Yahoo .KL code before fetching', async () => {
  const { SYMBOL_MAP } = await import('./symbol-map');
  SYMBOL_MAP['MAYBANK'] = '1155.KL';

  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = (async (url: string) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 9.5, chartPreviousClose: 9.4 } }] } }),
    };
  }) as typeof fetch;

  try {
    const { getStockPrice } = await import('./stocks');
    const quote = await getStockPrice('MAYBANK', 'stocks_my', 'MYR');

    assert.ok(quote);
    assert.equal(quote!.price, 9.5);
    assert.match(requestedUrl, /chart\/1155\.KL$/);
  } finally {
    global.fetch = originalFetch;
    delete SYMBOL_MAP['MAYBANK'];
  }
});

test('getStockPrice returns null for an unmapped MY/SG symbol without calling fetch', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({}) };
  }) as typeof fetch;

  try {
    const { getStockPrice } = await import('./stocks');
    const quote = await getStockPrice('UNKNOWN_CODE', 'stocks_sg', 'SGD');

    assert.equal(quote, null);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getStockPrice returns null when the response has no usable meta', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => ({ ok: true, json: async () => ({ chart: { result: [] } }) })) as typeof fetch;

  try {
    const { getStockPrice } = await import('./stocks');
    const quote = await getStockPrice('AAPL', 'stocks_us', 'USD');
    assert.equal(quote, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getStockPrice returns null when fetch throws', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { getStockPrice } = await import('./stocks');
    const quote = await getStockPrice('AAPL', 'stocks_us', 'USD');
    assert.equal(quote, null);
  } finally {
    global.fetch = originalFetch;
  }
});
```

- [ ] **Step 3: Register the test file and run it to see it fail**

In `package.json`, append `src/portfolio/price-fetcher/stocks.test.ts` to the `test` script.

Run: `npx tsx --test src/portfolio/price-fetcher/stocks.test.ts`
Expected: FAIL — `Cannot find module './stocks'`.

- [ ] **Step 4: Write `stocks.ts`**

```typescript
/**
 * US/MY/SG stock price fetching via Yahoo Finance's unofficial chart API.
 * MY (.KL) and SG (.SI) symbols are resolved through a manual mapping table
 * since broker statements report them differently than Yahoo does.
 */

import { AssetClass, Currency } from '../../types';
import { PriceQuote } from '../types';
import { resolveYahooSymbol } from './symbol-map';

function toYahooSymbol(symbol: string, assetClass: AssetClass): string | null {
  if (assetClass === 'stocks_us') {
    return symbol;
  }
  return resolveYahooSymbol(symbol);
}

export async function getStockPrice(
  symbol: string,
  assetClass: AssetClass,
  currency: Currency,
): Promise<PriceQuote | null> {
  const yahooSymbol = toYahooSymbol(symbol, assetClass);
  if (!yahooSymbol) {
    return null;
  }

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta || typeof meta.regularMarketPrice !== 'number' || typeof meta.chartPreviousClose !== 'number') {
      return null;
    }

    const changePct = ((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100;

    return {
      price: meta.regularMarketPrice,
      currency,
      change_pct: changePct,
      as_of: new Date(),
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test src/portfolio/price-fetcher/stocks.test.ts`
Expected: PASS, all 5 tests green.

- [ ] **Step 6: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/portfolio/price-fetcher/symbol-map.ts src/portfolio/price-fetcher/stocks.ts src/portfolio/price-fetcher/stocks.test.ts package.json
git commit -m "feat(portfolio): add Yahoo Finance stock price fetcher for US/MY/SG"
```

---

### Task 5: Unified price fetcher with in-memory TTL cache

**Files:**
- Create: `src/portfolio/price-fetcher/index.ts`
- Create: `src/portfolio/price-fetcher/index.test.ts`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `getCryptoPrice` from `./crypto` (Task 3), `getStockPrice` from `./stocks` (Task 4), `Holding`, `PriceQuote` from `../types` (Task 2).
- Produces: `getPrice(holding: Holding): Promise<PriceQuote | null>`, `_clearPriceCache(): void` (test-only)

- [ ] **Step 1: Write the failing test**

Create `src/portfolio/price-fetcher/index.test.ts`:

```typescript
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function fakeHolding(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '1',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    asset_class: 'stocks_us',
    quantity: 10,
    currency: 'USD',
    market: 'NASDAQ',
    broker: 'ibkr',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as any;
}

beforeEach(async () => {
  const { _clearPriceCache } = await import('./index');
  _clearPriceCache();
});

test('getPrice returns null for cash without calling fetch', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({}) };
  }) as typeof fetch;

  try {
    const { getPrice } = await import('./index');
    const quote = await getPrice(fakeHolding({ asset_class: 'cash', broker: null }));
    assert.equal(quote, null);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getPrice dispatches crypto holdings to the CoinGecko fetcher', async () => {
  const originalFetch = global.fetch;
  let requestedUrl = '';
  global.fetch = (async (url: string) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ bitcoin: { usd: 65000, usd_24h_change: 1 } }) };
  }) as typeof fetch;

  try {
    const { getPrice } = await import('./index');
    const quote = await getPrice(fakeHolding({ symbol: 'BTC', asset_class: 'crypto', broker: null }));
    assert.ok(quote);
    assert.equal(quote!.price, 65000);
    assert.match(requestedUrl, /coingecko/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getPrice caches a quote so a second call within the TTL does not refetch', async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = (async () => {
    callCount += 1;
    return {
      ok: true,
      json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: 190, chartPreviousClose: 180 } }] } }),
    };
  }) as typeof fetch;

  try {
    const { getPrice } = await import('./index');
    const holding = fakeHolding();

    const first = await getPrice(holding);
    const second = await getPrice(holding);

    assert.ok(first);
    assert.deepEqual(second, first);
    assert.equal(callCount, 1);
  } finally {
    global.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Register the test file and run it to see it fail**

In `package.json`, append `src/portfolio/price-fetcher/index.test.ts` to the `test` script.

Run: `npx tsx --test src/portfolio/price-fetcher/index.test.ts`
Expected: FAIL — `Cannot find module './index'`.

- [ ] **Step 3: Write `index.ts`**

```typescript
/**
 * Unified price fetching across asset classes, with a short in-memory
 * TTL cache (mirroring src/config/exchange-rates.ts — no DB-backed cache).
 */

import { Holding, PriceQuote } from '../types';
import { getCryptoPrice } from './crypto';
import { getStockPrice } from './stocks';

interface CacheEntry {
  quote: PriceQuote;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

const STOCK_TTL_MS = 15 * 60 * 1000;
const CRYPTO_TTL_MS = 5 * 60 * 1000;

function cacheKey(holding: Holding): string {
  return `${holding.asset_class}:${holding.symbol}`;
}

export async function getPrice(holding: Holding): Promise<PriceQuote | null> {
  if (holding.asset_class === 'cash') {
    return null;
  }

  const key = cacheKey(holding);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.quote;
  }

  let quote: PriceQuote | null;
  let ttl: number;

  if (holding.asset_class === 'crypto') {
    quote = await getCryptoPrice(holding.symbol as 'BTC' | 'ETH' | 'BETH');
    ttl = CRYPTO_TTL_MS;
  } else {
    quote = await getStockPrice(holding.symbol, holding.asset_class, holding.currency);
    ttl = STOCK_TTL_MS;
  }

  if (quote) {
    cache.set(key, { quote, expiresAt: Date.now() + ttl });
  }

  return quote;
}

/** Test-only: reset cache state between test cases. */
export function _clearPriceCache(): void {
  cache.clear();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/portfolio/price-fetcher/index.test.ts`
Expected: PASS, all 3 tests green.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/portfolio/price-fetcher/index.ts src/portfolio/price-fetcher/index.test.ts package.json
git commit -m "feat(portfolio): add unified price fetcher with in-memory TTL cache"
```

---

### Task 6: Allocation calculator (pure functions)

**Files:**
- Create: `src/portfolio/calculator.ts`
- Create: `src/portfolio/calculator.test.ts`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `toSGD` from `../config` (existing), `Holding`, `PriceQuote`, `EnrichedHolding`, `AllocationEntry`, `PortfolioSummary` from `./types` (Task 2).
- Produces:
  - `enrichHolding(holding: Holding, quote: PriceQuote | null): EnrichedHolding`
  - `calculateNetWorth(holdings: EnrichedHolding[]): number`
  - `calculateAllocation(holdings: EnrichedHolding[]): { by_class: AllocationEntry[]; by_currency: AllocationEntry[] }`
  - `buildPortfolioSummary(holdings: EnrichedHolding[]): PortfolioSummary`

- [ ] **Step 1: Write the failing test**

Create `src/portfolio/calculator.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichHolding, calculateNetWorth, calculateAllocation, buildPortfolioSummary } from './calculator';
import { Holding, PriceQuote } from './types';

function fakeHolding(overrides: Partial<Holding> = {}): Holding {
  return {
    id: '1',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    asset_class: 'stocks_us',
    quantity: 10,
    currency: 'USD',
    market: 'NASDAQ',
    broker: 'ibkr',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function fakeQuote(overrides: Partial<PriceQuote> = {}): PriceQuote {
  return { price: 100, currency: 'USD', change_pct: 1, as_of: new Date(), ...overrides };
}

test('enrichHolding values a stock holding in SGD cents using quantity * price, converted from the quote currency', () => {
  const holding = fakeHolding({ quantity: 10, currency: 'USD' });
  const quote = fakeQuote({ price: 100, currency: 'USD' }); // 10 * 100 = 1000 USD

  const enriched = enrichHolding(holding, quote);

  // USD -> SGD at the static EXCHANGE_RATES rate (USD: 0.75 means 1 SGD = 0.75 USD,
  // so 1000 USD -> 1000 / 0.75 = 1333.33 SGD -> 133333 cents, rounded).
  assert.equal(enriched.value_sgd, Math.round((1000 / 0.75) * 100));
  assert.equal(enriched.quote, quote);
});

test('enrichHolding values a holding with no quote as 0', () => {
  const holding = fakeHolding();
  const enriched = enrichHolding(holding, null);

  assert.equal(enriched.value_sgd, 0);
  assert.equal(enriched.quote, null);
});

test('enrichHolding values cash directly from quantity, ignoring quote', () => {
  const holding = fakeHolding({ asset_class: 'cash', symbol: 'SGD', quantity: 5000, currency: 'SGD' });
  const enriched = enrichHolding(holding, null);

  assert.equal(enriched.value_sgd, 500000); // S$5000 -> 500000 cents
});

test('calculateNetWorth sums value_sgd across mixed holdings', () => {
  const holdings = [
    enrichHolding(fakeHolding({ symbol: 'A' }), fakeQuote()),
    enrichHolding(fakeHolding({ symbol: 'B', asset_class: 'cash', quantity: 1000, currency: 'SGD' }), null),
  ];

  const netWorth = calculateNetWorth(holdings);
  assert.equal(netWorth, holdings[0].value_sgd + holdings[1].value_sgd);
});

test('calculateAllocation splits by class and currency with percentages summing to ~100', () => {
  const holdings = [
    enrichHolding(fakeHolding({ symbol: 'A', asset_class: 'stocks_us', currency: 'USD' }), fakeQuote({ price: 100 })),
    enrichHolding(fakeHolding({ symbol: 'B', asset_class: 'crypto', currency: 'USD', quantity: 1 }), fakeQuote({ price: 50 })),
  ];

  const { by_class, by_currency } = calculateAllocation(holdings);

  const classTotal = by_class.reduce((sum, e) => sum + e.pct, 0);
  const currencyTotal = by_currency.reduce((sum, e) => sum + e.pct, 0);

  assert.ok(Math.abs(classTotal - 100) < 0.2);
  assert.ok(Math.abs(currencyTotal - 100) < 0.2);
  assert.ok(by_class.some((e) => e.key === 'stocks_us'));
  assert.ok(by_class.some((e) => e.key === 'crypto'));
});

test('buildPortfolioSummary composes net worth, allocation, and holdings; empty input yields zeros', () => {
  const summary = buildPortfolioSummary([]);
  assert.equal(summary.net_worth_sgd, 0);
  assert.deepEqual(summary.by_class, []);
  assert.deepEqual(summary.by_currency, []);
  assert.deepEqual(summary.holdings, []);
});
```

- [ ] **Step 2: Register the test file and run it to see it fail**

In `package.json`, append `src/portfolio/calculator.test.ts` to the `test` script.

Run: `npx tsx --test src/portfolio/calculator.test.ts`
Expected: FAIL — `Cannot find module './calculator'`.

- [ ] **Step 3: Write `calculator.ts`**

```typescript
/**
 * Pure net worth and allocation math. No I/O — takes holdings + their
 * already-fetched price quotes and produces a PortfolioSummary.
 */

import { toSGD } from '../config';
import { AllocationEntry, EnrichedHolding, Holding, PortfolioSummary, PriceQuote } from './types';

function computeValueSgd(holding: Holding, quote: PriceQuote | null): number {
  if (holding.asset_class === 'cash') {
    return toSGD(Math.round(holding.quantity * 100), holding.currency);
  }
  if (!quote) {
    return 0;
  }
  const valueInQuoteCurrency = holding.quantity * quote.price;
  return toSGD(Math.round(valueInQuoteCurrency * 100), quote.currency);
}

export function enrichHolding(holding: Holding, quote: PriceQuote | null): EnrichedHolding {
  return { ...holding, quote, value_sgd: computeValueSgd(holding, quote) };
}

export function calculateNetWorth(holdings: EnrichedHolding[]): number {
  return holdings.reduce((sum, h) => sum + h.value_sgd, 0);
}

function buildAllocation(holdings: EnrichedHolding[], keyOf: (h: EnrichedHolding) => string): AllocationEntry[] {
  const totals = new Map<string, number>();
  for (const h of holdings) {
    const key = keyOf(h);
    totals.set(key, (totals.get(key) ?? 0) + h.value_sgd);
  }

  const netWorth = calculateNetWorth(holdings);

  return Array.from(totals.entries()).map(([key, value_sgd]) => ({
    key,
    value_sgd,
    pct: netWorth > 0 ? Math.round((value_sgd / netWorth) * 1000) / 10 : 0,
  }));
}

export function calculateAllocation(
  holdings: EnrichedHolding[],
): { by_class: AllocationEntry[]; by_currency: AllocationEntry[] } {
  return {
    by_class: buildAllocation(holdings, (h) => h.asset_class),
    by_currency: buildAllocation(holdings, (h) => h.currency),
  };
}

export function buildPortfolioSummary(holdings: EnrichedHolding[]): PortfolioSummary {
  const { by_class, by_currency } = calculateAllocation(holdings);
  return {
    net_worth_sgd: calculateNetWorth(holdings),
    by_class,
    by_currency,
    holdings,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/portfolio/calculator.test.ts`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/portfolio/calculator.ts src/portfolio/calculator.test.ts package.json
git commit -m "feat(portfolio): add pure net worth and allocation calculator"
```

---

### Task 7: Statement parser (Gemini multimodal)

**Files:**
- Create: `src/portfolio/statement-parser.ts`
- Create: `src/portfolio/statement-parser.test.ts`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `config` from `../config` (existing, `GOOGLE_API_KEY`), `Broker`, `ParsedHolding`, `ParsedStatement` from `./types` (Task 2).
- Produces: `parseStatement(pdfBuffer: Buffer): Promise<ParsedStatement>`, `parseGeminiStatementResponse(rawText: string): ParsedStatement`, `class StatementParseError extends Error`

- [ ] **Step 1: Write the failing test**

Create `src/portfolio/statement-parser.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiStatementResponse, StatementParseError } from './statement-parser';

test('parseGeminiStatementResponse maps a valid IBKR JSON response', () => {
  const raw = `Here you go:\n{"broker": "ibkr", "holdings": [{"symbol": "AAPL", "name": "Apple Inc.", "quantity": 10, "asset_class": "stocks_us", "currency": "USD", "market": "NASDAQ"}]}`;

  const result = parseGeminiStatementResponse(raw);

  assert.equal(result.broker, 'ibkr');
  assert.equal(result.holdings.length, 1);
  assert.equal(result.holdings[0].symbol, 'AAPL');
});

test('parseGeminiStatementResponse maps a valid Moomoo JSON response', () => {
  const raw = `{"broker": "moomoo", "holdings": [{"symbol": "SIA", "name": "Singapore Airlines", "quantity": 100, "asset_class": "stocks_sg", "currency": "SGD", "market": "SGX"}]}`;

  const result = parseGeminiStatementResponse(raw);

  assert.equal(result.broker, 'moomoo');
  assert.equal(result.holdings[0].asset_class, 'stocks_sg');
});

test('parseGeminiStatementResponse throws StatementParseError on unparseable text', () => {
  assert.throws(() => parseGeminiStatementResponse('not json at all'), StatementParseError);
});

test('parseGeminiStatementResponse throws StatementParseError on invalid JSON', () => {
  assert.throws(() => parseGeminiStatementResponse('{ broken json'), StatementParseError);
});

test('parseGeminiStatementResponse throws StatementParseError when broker is unrecognized', () => {
  assert.throws(
    () => parseGeminiStatementResponse('{"broker": null, "holdings": []}'),
    StatementParseError,
  );
});

test('parseGeminiStatementResponse throws StatementParseError when holdings is empty', () => {
  assert.throws(
    () => parseGeminiStatementResponse('{"broker": "ibkr", "holdings": []}'),
    StatementParseError,
  );
});

test('parseStatement surfaces a Gemini/network failure as StatementParseError, not a thrown network error', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { parseStatement } = await import('./statement-parser');
    await assert.rejects(() => parseStatement(Buffer.from('%PDF-1.4 fake')), StatementParseError);
  } finally {
    global.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Register the test file and run it to see it fail**

In `package.json`, append `src/portfolio/statement-parser.test.ts` to the `test` script.

Run: `npx tsx --test src/portfolio/statement-parser.test.ts`
Expected: FAIL — `Cannot find module './statement-parser'`.

- [ ] **Step 3: Write `statement-parser.ts`**

```typescript
/**
 * Parses an IBKR or Moomoo brokerage statement PDF into structured
 * holdings via Gemini multimodal. No rule-based/per-broker-parser
 * fallback — Pluto AI is Gemini-first (see CLAUDE.md); any failure here
 * is surfaced as StatementParseError, not guessed.
 *
 * NOTE: the prompt below has not yet been validated against real IBKR/
 * Moomoo statement PDFs (none were available when this was written) —
 * see the "Sample statements not yet provided" scope decision in the
 * spec. Revisit once real statements are available.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';
import { Broker, ParsedHolding, ParsedStatement } from './types';

export class StatementParseError extends Error {}

const SYSTEM_INSTRUCTION = `You are a financial statement parser for Pluto AI. You will receive a PDF of a brokerage statement from either Interactive Brokers (IBKR) or Moomoo. Identify which broker issued it from its layout/branding, then extract every open stock/ETF position from its "Open Positions" (IBKR) or "Positions" (Moomoo) section. Return strict JSON only, matching exactly this shape:
{"broker": "ibkr" | "moomoo", "holdings": [{"symbol": string, "name": string, "quantity": number, "asset_class": "stocks_us" | "stocks_my" | "stocks_sg", "currency": "USD" | "MYR" | "SGD", "market": string}]}
Do not include cash balances, options, or futures. If you cannot confidently identify the broker or find no open positions, return {"broker": null, "holdings": []}.`;

export function parseGeminiStatementResponse(rawText: string): ParsedStatement {
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new StatementParseError('Gemini returned an unparseable response');
  }

  let parsed: { broker?: string | null; holdings?: unknown[] };
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    throw new StatementParseError('Gemini returned invalid JSON');
  }

  if (parsed.broker !== 'ibkr' && parsed.broker !== 'moomoo') {
    throw new StatementParseError('Could not identify the statement broker');
  }

  const holdings = (parsed.holdings ?? []) as ParsedHolding[];
  if (holdings.length === 0) {
    throw new StatementParseError(
      'No holdings found in the statement — treated as a parse failure, not an emptied account',
    );
  }

  return { broker: parsed.broker as Broker, holdings };
}

export async function parseStatement(pdfBuffer: Buffer): Promise<ParsedStatement> {
  try {
    const genAI = new GoogleGenerativeAI(config.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      systemInstruction: SYSTEM_INSTRUCTION,
    });

    // Multimodal PDF calls run slower than short text-classification prompts
    // (ai.ts's 15s budget) — 30s gives enough headroom to not misfire.
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Gemini statement parse timed out after 30s')), 30000);
    });

    const result = await Promise.race([
      model.generateContent([
        { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { text: 'Extract the holdings as instructed and return only the JSON.' },
      ]),
      timeoutPromise,
    ]);

    return parseGeminiStatementResponse(result.response.text());
  } catch (error) {
    if (error instanceof StatementParseError) {
      throw error;
    }
    throw new StatementParseError(`Gemini statement parsing failed: ${(error as Error).message}`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/portfolio/statement-parser.test.ts`
Expected: PASS, all 7 tests green.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/portfolio/statement-parser.ts src/portfolio/statement-parser.test.ts package.json
git commit -m "feat(portfolio): add Gemini multimodal statement parser"
```

---

### Task 8: Public module exports and `getPortfolioSummary` orchestration

**Files:**
- Create: `src/portfolio/index.ts`

**Interfaces:**
- Consumes: everything produced in Tasks 2–7.
- Produces: the module's public surface (`from '../portfolio'`), plus `getPortfolioSummary(): Promise<PortfolioSummary>`.

- [ ] **Step 1: Write `index.ts`**

```typescript
/**
 * Portfolio module public API.
 */

import { getPrice } from './price-fetcher';
import { enrichHolding, buildPortfolioSummary, calculateNetWorth, calculateAllocation } from './calculator';
import { listHoldings } from './service';
import { PortfolioSummary } from './types';

export * from './types';
export { addHolding, removeHolding, replaceHoldingsForBroker, listHoldings } from './service';
export { parseStatement, StatementParseError } from './statement-parser';
export { getPrice } from './price-fetcher';
export { calculateNetWorth, calculateAllocation, enrichHolding, buildPortfolioSummary } from './calculator';

export async function getPortfolioSummary(): Promise<PortfolioSummary> {
  const holdings = await listHoldings();
  const enriched = await Promise.all(
    holdings.map(async (holding) => enrichHolding(holding, await getPrice(holding))),
  );
  return buildPortfolioSummary(enriched);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/portfolio/index.ts
git commit -m "feat(portfolio): add public module exports and getPortfolioSummary"
```

---

### Task 9: `/portfolio` command

**Files:**
- Modify: `src/bot/commands/portfolio.ts`

**Interfaces:**
- Consumes: `getPortfolioSummary` from `../../portfolio` (Task 8), `formatCurrency` from `../../config` (existing).
- Produces: `handlePortfolioCommand(): Promise<string>` (signature unchanged — already wired into `src/bot/index.ts:48-51`).

- [ ] **Step 1: Replace the placeholder handler**

Replace the full contents of `src/bot/commands/portfolio.ts` with:

```typescript
/**
 * /portfolio command handler
 */

import { getPortfolioSummary } from '../../portfolio';
import { formatCurrency } from '../../config';

export async function handlePortfolioCommand(): Promise<string> {
  const summary = await getPortfolioSummary();

  if (summary.holdings.length === 0) {
    return 'No holdings yet. Upload an IBKR/Moomoo statement PDF, or tell me something like "I hold 0.5 BTC" or "cash SGD 5000" to get started.';
  }

  const lines = [`Net worth: ${formatCurrency(summary.net_worth_sgd, 'SGD')}`, '', 'By asset class:'];
  for (const entry of summary.by_class) {
    lines.push(`  ${entry.key}: ${formatCurrency(entry.value_sgd, 'SGD')} (${entry.pct}%)`);
  }

  lines.push('', 'By currency:');
  for (const entry of summary.by_currency) {
    lines.push(`  ${entry.key}: ${formatCurrency(entry.value_sgd, 'SGD')} (${entry.pct}%)`);
  }

  lines.push('', 'Holdings:');
  for (const holding of summary.holdings) {
    const movement = holding.quote
      ? `${holding.quote.change_pct >= 0 ? '+' : ''}${holding.quote.change_pct.toFixed(2)}%`
      : 'price unavailable';
    lines.push(`  ${holding.symbol}: ${holding.quantity} — ${formatCurrency(holding.value_sgd, 'SGD')} (${movement})`);
  }

  return lines.join('\n');
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual verification**

This handler has no dedicated test (matching the existing convention — `/today`, `/month`, and `/budget` also have no command-level tests). Verify manually:

```bash
npx tsx -e "
process.env.DATABASE_URL = './data/manual-check-portfolio.db';
import('./src/db/migrate').then(async ({ runMigrations }) => {
  runMigrations();
  const { addHolding } = await import('./src/portfolio/service');
  await addHolding({ symbol: 'SGD', name: 'Cash', quantity: 1000, asset_class: 'cash', currency: 'SGD', market: 'Cash' });
  const { handlePortfolioCommand } = await import('./src/bot/commands/portfolio');
  console.log(await handlePortfolioCommand());
});
"
```

Expected: prints "Net worth: S\$1000.00" and a `cash` line under both allocation sections. Then delete the scratch db: `rm -f ./data/manual-check-portfolio.db`.

- [ ] **Step 4: Commit**

```bash
git add src/bot/commands/portfolio.ts
git commit -m "feat(bot): wire /portfolio command to real portfolio summary"
```

---

### Task 10: Statement PDF upload — document handler and bot wiring

**Files:**
- Create: `src/bot/handlers/document.ts`
- Create: `src/bot/handlers/document.test.ts`
- Modify: `src/bot/index.ts`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `parseStatement`, `StatementParseError` from `../../portfolio/statement-parser` (Task 7), `replaceHoldingsForBroker` from `../../portfolio/service` (Task 2), `getPortfolioSummary` from `../../portfolio` (Task 8), `formatCurrency` from `../../config` (existing).
- Produces: `handleDocumentMessage(fileBuffer: Buffer, mimeType: string): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `src/bot/handlers/document.test.ts`:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-document-handler.db';

const testDbPath = path.resolve('./data/test-document-handler.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  runMigrations();
});

test('handleDocumentMessage rejects a non-PDF file without calling Gemini', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error('should not be called');
  }) as typeof fetch;

  try {
    const { handleDocumentMessage } = await import('./document');
    const reply = await handleDocumentMessage(Buffer.from('not a pdf'), 'image/png');

    assert.match(reply, /PDF/i);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleDocumentMessage returns a friendly message when statement parsing fails', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { handleDocumentMessage } = await import('./document');
    const reply = await handleDocumentMessage(Buffer.from('%PDF-1.4 fake'), 'application/pdf');

    assert.match(reply, /couldn't read/i);
  } finally {
    global.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Register the test file and run it to see it fail**

In `package.json`, append `src/bot/handlers/document.test.ts` to the `test` script.

Run: `npx tsx --test src/bot/handlers/document.test.ts`
Expected: FAIL — `Cannot find module './document'`.

- [ ] **Step 3: Write `document.ts`**

```typescript
/**
 * Statement PDF upload handling for the Telegram bot.
 */

import { logger } from '../../utils/logger';
import { parseStatement, StatementParseError } from '../../portfolio/statement-parser';
import { replaceHoldingsForBroker } from '../../portfolio/service';
import { getPortfolioSummary } from '../../portfolio';
import { formatCurrency } from '../../config';

export async function handleDocumentMessage(fileBuffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType !== 'application/pdf') {
    return "I can only read PDF statements right now — please upload your IBKR or Moomoo statement as a PDF.";
  }

  let parsed;
  try {
    parsed = await parseStatement(fileBuffer);
  } catch (error) {
    if (error instanceof StatementParseError) {
      logger.warn('Statement parse failed', { message: error.message });
      return `I couldn't read that statement (${error.message}). Try re-uploading, or check it's an IBKR/Moomoo statement PDF.`;
    }
    throw error;
  }

  const updated = await replaceHoldingsForBroker(parsed.broker, parsed.holdings);
  const summary = await getPortfolioSummary();

  return `Updated ${parsed.broker.toUpperCase()} holdings — ${updated.length} position(s). New net worth: ${formatCurrency(summary.net_worth_sgd, 'SGD')}.`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/bot/handlers/document.test.ts`
Expected: PASS, both tests green.

- [ ] **Step 5: Wire the `message:document` handler into the bot**

In `src/bot/index.ts`, add the import alongside the existing handler imports:

```typescript
import { handleDocumentMessage } from './handlers/document';
```

And add this block after the existing `this.bot.on('message:voice', ...)` block (still inside `start()`, before `this.bot.command('start', ...)`):

```typescript
    this.bot.on('message:document', async (ctx) => {
      const document = ctx.message.document;
      if (!document) {
        return;
      }
      const file = await ctx.api.getFile(document.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      const reply = await handleDocumentMessage(buffer, document.mime_type ?? '');
      await this.replyWithText(ctx, reply);
    });
```

- [ ] **Step 6: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/bot/handlers/document.ts src/bot/handlers/document.test.ts src/bot/index.ts package.json
git commit -m "feat(bot): add statement PDF upload handling"
```

---

### Task 11: Wire the `holdings` chat intent (crypto/cash)

**Files:**
- Modify: `src/bot/types.ts`
- Modify: `src/bot/ai.ts`
- Modify: `src/bot/ai.test.ts`

**Interfaces:**
- Consumes: `addHolding`, `removeHolding` from `../portfolio/service` (Task 2), `AssetClass`, `Currency` from `../types` (existing).
- Produces: `BotIntent` gains `'holdings'`; `buildAssistantReply`'s external signature is unchanged, with a new `case 'holdings'` branch.

- [ ] **Step 1: Extend `BotIntent`**

In `src/bot/types.ts`, change:

```typescript
export type BotIntent =
  | 'expense'
  | 'query'
  | 'budget'
  | 'correction'
  | 'recurring'
  | 'help'
  | 'unknown';
```

to:

```typescript
export type BotIntent =
  | 'expense'
  | 'query'
  | 'budget'
  | 'correction'
  | 'recurring'
  | 'holdings'
  | 'help'
  | 'unknown';
```

- [ ] **Step 2: Write the failing tests**

In `src/bot/ai.test.ts`, add these tests after the existing budget-intent tests:

```typescript
test('buildAssistantReply records a new crypto holding for the holdings intent', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply({
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'BTC', amount: 0.5, assetClass: 'crypto', currency: 'USD' },
    rawText: 'I hold 0.5 BTC',
  });

  assert.match(reply, /BTC/);

  const { listHoldings } = await import('../portfolio/service');
  const allHoldings = await listHoldings();
  const btc = allHoldings.find((h) => h.symbol === 'BTC');

  assert.ok(btc);
  assert.equal(btc!.quantity, 0.5);
  assert.equal(btc!.broker, null);
});

test('buildAssistantReply removes a holding when the action indicates removal', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { addHolding, listHoldings } = await import('../portfolio/service');
  await addHolding({ symbol: 'ETH', name: 'ETH', quantity: 1, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });

  const reply = await buildAssistantReply({
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'ETH', action: 'remove' },
    rawText: 'Remove my ETH holding',
  });

  assert.match(reply, /removed/i);

  const allHoldings = await listHoldings();
  assert.ok(!allHoldings.some((h) => h.symbol === 'ETH'));
});

test('buildAssistantReply asks which holding when the holdings intent has no symbol', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply({
    intent: 'holdings',
    confidence: 0.5,
    extracted: {},
    rawText: 'I have some crypto',
  });

  assert.match(reply, /which holding/i);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx tsx --test src/bot/ai.test.ts`
Expected: FAIL on the three new tests — `'holdings'` isn't a handled case yet (falls through to the `default` branch).

- [ ] **Step 4: Extend `ExtractedFields`, the system instruction, and imports**

In `src/bot/ai.ts`, add a new import line right after the existing `import { BotIntent } from './types';`:

```typescript
import { AssetClass, Currency } from '../types';
```

Then change:

```typescript
export interface ExtractedFields {
  amount?: number;
  merchant?: string;
  category?: string;
  period?: string;
  budgetAmount?: number;
  action?: string;
}
```

to:

```typescript
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
}
```

And change the `systemInstruction` string's intent/field lists — replace:

```typescript
        'You are Pluto AI, a personal finance assistant in Telegram. Classify each user message and return strict JSON only. Return fields: intent, confidence, extracted { amount, merchant, category, period, budgetAmount, action }, rawText. Allowed intents: expense, query, budget, correction, recurring, help, unknown. Use decimal numbers for money values like 4.5. Keep responses concise and practical.',
```

with:

```typescript
        'You are Pluto AI, a personal finance assistant in Telegram. Classify each user message and return strict JSON only. Return fields: intent, confidence, extracted { amount, merchant, category, period, budgetAmount, action, symbol, assetClass, currency }, rawText. Allowed intents: expense, query, budget, correction, recurring, holdings, help, unknown. The holdings intent covers non-brokerage portfolio updates like "I hold 0.5 BTC" or "cash SGD 5000" — extract symbol (e.g. BTC, SGD), assetClass (crypto or cash), currency, and amount as the quantity. Use decimal numbers for money values like 4.5. Keep responses concise and practical.',
```

- [ ] **Step 5: Add the `'holdings'` case to `buildAssistantReply`**

In `src/bot/ai.ts`, add this case inside the `switch (intent)` block, after the existing `case 'recurring':` block and before `case 'query':`:

```typescript
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

      const assetClass = (extracted.assetClass as AssetClass) ?? 'crypto';
      const currency = (extracted.currency as Currency) ?? 'USD';

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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx --test src/bot/ai.test.ts`
Expected: PASS, including all pre-existing tests in this file.

- [ ] **Step 7: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/bot/types.ts src/bot/ai.ts src/bot/ai.test.ts
git commit -m "feat(bot): wire the holdings chat intent for crypto/cash"
```

---

### Task 12: Final verification and doc sync

**Files:**
- Modify: `docs/tasks/04-portfolio-tracker.md`

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — every file listed in `package.json`'s `test` script succeeds.

- [ ] **Step 2: Run the type checker and build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors, `dist/` builds successfully.

- [ ] **Step 3: Update the task doc's status**

In `docs/tasks/04-portfolio-tracker.md`, change the `**Status: not started.**` paragraph to:

```markdown
**Status: implemented**, with two known gaps — see below. See
`src/portfolio/`, the wired `/portfolio` command, the statement PDF
upload flow, and the `holdings` chat intent.
```

Check off every acceptance criteria bullet that's genuinely done (holdings CRUD, US/MY/SG price fetching, crypto price fetching, SGD net worth, allocation by class/currency, currency exposure, daily movement, cash balances, `/portfolio` summary). Leave unchecked and annotate:
- "Malaysian stock prices fetched (Bursa Malaysia data source)" — implemented via Yahoo Finance `.KL` symbols, but only for symbols present in the manual `src/portfolio/price-fetcher/symbol-map.ts` table; unmapped symbols show "price unavailable".
- Add a note that the Gemini statement-extraction prompt is unvalidated against real IBKR/Moomoo PDFs pending sample statements (see the design spec's scope decision).

- [ ] **Step 4: Commit**

```bash
git add docs/tasks/04-portfolio-tracker.md
git commit -m "docs: mark PLUTO-04 portfolio tracker as implemented"
```
