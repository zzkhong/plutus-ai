# PLUTO-04: Portfolio Tracker — Design

Source requirements: [doc/tasks/04-portfolio-tracker.md](../../../doc/tasks/04-portfolio-tracker.md)

## Goal

Track the user's investment portfolio (US stocks via IBKR, SG/MY/US
stocks via Moomoo, crypto, cash) and surface total net worth in SGD,
allocation by asset class and currency, and daily price movement via
`/portfolio`. Holdings for brokerage accounts are populated by
uploading a statement PDF, not by typing individual buy/sell entries.

## Scope decisions (resolved during brainstorming)

- **Holdings input is split by source, not unified.** Brokerage
  holdings (US/SG/MY stocks) come from uploading a statement PDF
  (IBKR or Moomoo) as a Telegram document — the user explicitly wants
  this over manual "Add 10 AAPL" chat commands, since statements are
  the source of truth they already reconcile against. Crypto and cash
  holdings have no statement to upload, so those stay chat-driven via
  a new `holdings` NL intent (e.g. "I hold 0.5 BTC", "cash SGD 5000"),
  wired the same dynamic-import way the existing `budget` and
  `correction` intents are in `src/bot/ai.ts`.
- **PDF parsing uses Gemini multimodal, not per-broker code parsers.**
  Consistent with the project's Gemini-first-no-fallback philosophy
  (see CLAUDE.md), the PDF is sent to Gemini as inline `application/pdf`
  data with a prompt asking it to both identify the broker (IBKR vs
  Moomoo) from the statement's own layout/branding and extract holdings
  as structured JSON — the user does not specify which broker they're
  uploading. If Gemini fails or returns unparseable output, the upload
  is rejected with an error reply; there is no rule-based PDF parser
  fallback, matching how `classifyUserMessage` degrades to
  `serviceError` rather than guessing.
- **Full snapshot replace, scoped by broker.** Each statement upload
  replaces all previously stored holdings for that detected broker with
  the statement's ending positions. Holdings from the *other* broker,
  and manually-entered crypto/cash, are untouched. This avoids drift
  from partially-sold positions lingering after a missed upload, and
  matches how a statement already represents a point-in-time snapshot
  rather than a transaction log.
- **Price fetching: Yahoo Finance's unofficial chart API for both US
  and MY stocks**, one unified fetcher module rather than two separate
  integrations. Alpha Vantage was considered and rejected — its free
  tier (25 requests/day) is too tight to poll a whole portfolio, and
  its Bursa Malaysia coverage is inconsistent. TradingView was
  considered and rejected — it has no public API; the only way to pull
  data is scraping, which violates its ToS and is fragile. Yahoo's
  `query1.finance.yahoo.com/v8/finance/chart/{symbol}` endpoint needs
  no key/login and already covers Bursa Malaysia via a `.KL` suffix
  (numeric stock code, e.g. `1155.KL` for Maybank).
- **MY stock symbol mapping is a manual, code-maintained table**, not
  derived automatically. A Moomoo statement reports a stock by name or
  local code, which won't reliably match Yahoo's `NNNN.KL` numeric
  code. `price-fetcher/symbol-map.ts` is a small hand-maintained
  `{ statementSymbol: string -> yahooSymbol: string }` object the user
  fills in per MY (and SG, see below) holding; an unmapped symbol falls
  back to "price unavailable" for that holding rather than failing the
  whole summary.
- **`AssetClass` gains `'stocks_sg'`.** The existing type (`stocks_us |
  stocks_my | crypto | cash`, from `src/types/portfolio.ts`) has no SG
  bucket, but Moomoo holds SG stocks alongside MY and US, and SG
  stocks are SGD-denominated — lumping them into `stocks_my` would
  misreport currency exposure (MYR vs SGD) even though both trade
  through the same broker. `price-fetcher/stocks.ts` handles SGX the
  same way as Bursa: a `.SI` suffix on Yahoo's chart API, with its own
  manual symbol-mapping table entry set (SGX tickers are usually
  alphabetic and often match Yahoo's `.SI` symbol directly, but an
  unmapped one still degrades to "unavailable" rather than guessing).
- **Crypto pricing via CoinGecko's free API**, unchanged from the
  original task doc. BETH is fetched directly under CoinGecko's own
  `binance-staked-eth` coin id rather than approximated as
  `ETH * ratio`, since CoinGecko already prices it independently.
- **No `price_cache` DB table.** The task doc's original design called
  for a persisted price cache; this design drops it. Yahoo's chart API
  and CoinGecko's simple-price endpoint both already return the
  previous-close / 24h-change figure needed for "daily movement" in
  the same response as the current price, so there is no need to
  persist price history ourselves. Prices are cached in-memory with a
  short TTL, mirroring the existing pattern in
  `src/config/exchange-rates.ts` (in-memory, time-based, no DB-backed
  cache) — 15 minutes for stocks, 5 minutes for crypto.
- **Sample statements not yet provided.** The user intends to share one
  IBKR and one Moomoo sample PDF to validate the extraction prompt and
  schema. Implementation proceeds now with a best-effort prompt/schema
  based on each broker's publicly documented statement structure
  (IBKR Activity Statement's "Open Positions" section; Moomoo's
  "Positions" statement section), tested against mocked Gemini
  responses. This is a known gap: the prompt has not been validated
  against real statement text/layout and should be revisited once
  sample PDFs are available — treat early real-world uploads as
  provisional until then.

## Module layout

```
src/portfolio/
├── index.ts                  # public exports
├── types.ts                  # Broker, ParsedStatement, PortfolioSummary, etc.
├── service.ts                 # Drizzle CRUD against `holdings`
├── statement-parser.ts        # Gemini multimodal PDF -> ParsedStatement
├── calculator.ts               # net worth & allocation math (pure)
└── price-fetcher/
    ├── index.ts                # unified getPrice(holding) -> PriceQuote
    ├── stocks.ts                # Yahoo Finance chart API (US + MY + SG)
    ├── crypto.ts                 # CoinGecko simple-price API
    └── symbol-map.ts             # manual statementSymbol -> yahooSymbol table (MY + SG)
```

### `types.ts`

```typescript
type Broker = 'ibkr' | 'moomoo';

interface ParsedHolding {
  symbol: string;       // as reported on the statement
  name: string;
  quantity: number;
  asset_class: AssetClass; // 'stocks_us' | 'stocks_my' | 'stocks_sg'
  currency: Currency;
  market: string;        // e.g. 'NASDAQ', 'Bursa Malaysia'
}

interface ParsedStatement {
  broker: Broker;
  holdings: ParsedHolding[];
}

interface PriceQuote {
  price: number;          // in quote currency, not cents
  currency: Currency;
  change_pct: number;     // vs previous close / 24h
  as_of: Date;
}

interface PortfolioSummary {
  net_worth_sgd: number;  // in SGD cents
  by_class: { class: AssetClass; value_sgd: number; pct: number }[];
  by_currency: { currency: Currency; value_sgd: number; pct: number }[];
  holdings: (Holding & { quote?: PriceQuote; value_sgd: number })[];
}
```

### `service.ts`

```typescript
addHolding(data: HoldingInput): Promise<Holding>            // crypto/cash, broker = null
removeHolding(symbol: string): Promise<void>                 // crypto/cash, broker = null
replaceHoldingsForBroker(broker: Broker, holdings: ParsedHolding[]): Promise<Holding[]>
listHoldings(): Promise<Holding[]>
```

- Uses `db` from `src/db/client.ts` and the `holdings` Drizzle table —
  same access style as the budget module (Drizzle, not the expense
  module's raw-SQL pattern), since this is new code with no legacy
  constraint.
- `replaceHoldingsForBroker` runs inside a single transaction: delete
  all rows where `broker = <broker>`, then insert the new rows. If
  Gemini's extraction returns zero holdings for a statement, the
  upload is rejected before this call runs (treated as a parse failure,
  not "you now have zero holdings") — an empty positions section is far
  more likely to mean a parsing miss than an emptied account.
- `addHolding`/`removeHolding` operate only on rows with `broker IS
  NULL` (manually entered) — they cannot target a brokerage-sourced
  holding, preventing a chat command from silently fighting the next
  statement upload.

### `statement-parser.ts`

```typescript
parseStatement(pdfBuffer: Buffer): Promise<ParsedStatement>
```

- Sends the PDF to Gemini (`gemini-3.6-flash`, multimodal) as an
  inline `{ mimeType: 'application/pdf', data: base64 }` part, with a
  system prompt describing both statement formats' "Open
  Positions"/"Positions" layout and asking for strict JSON matching
  `ParsedStatement`.
- On any failure (timeout, network error, unparseable JSON, or an
  empty `holdings` array) throws a typed `StatementParseError` — no
  fallback parser, matching `classifyUserMessage`'s degrade-don't-guess
  behavior. The document handler catches this and replies with an
  error, mirroring `formatUserFriendlyError()`.
- Timeout: 30s (larger than the 15s text-classification budget in
  `ai.ts`, since multimodal PDF calls run slower than short text
  prompts).

### `calculator.ts`

```typescript
calculateNetWorth(holdings: (Holding & { quote?: PriceQuote })[]): number // SGD cents
calculateAllocation(holdings): { by_class: Allocation[]; by_currency: Allocation[] }
```

- Pure functions: `value_sgd` per holding = `quantity * quote.price *
  exchangeRateToSGD` (via the existing `toSGD` helper in
  `src/config/currencies.ts`), or `quantity * 100` cents directly for
  `asset_class === 'cash'` (quantity already holds the cash amount,
  price is implicitly 1, matching the task doc's note).
- A holding with no `quote` (price fetch failed, or an unmapped MY
  symbol) contributes `0` to net worth/allocation but is still listed
  in the summary with an "unavailable" marker — a fetch failure
  degrades that one line, not the whole `/portfolio` response.

### `price-fetcher/index.ts`

```typescript
getPrice(holding: Holding): Promise<PriceQuote | null>
```

- Dispatches by `asset_class`: `'stocks_us' | 'stocks_my' |
  'stocks_sg'` → `stocks.ts`, `'crypto'` → `crypto.ts`, `'cash'` →
  `null` (no price concept). Returns `null` on any fetch/mapping
  failure rather than throwing — callers (the calculator) treat `null`
  as "unavailable."
- In-memory cache keyed by `symbol`, TTL 15 min (stocks) / 5 min
  (crypto), same shape as `exchange-rates.ts`'s cache — no new
  dependency introduced.

### `price-fetcher/stocks.ts`

- `GET https://query1.finance.yahoo.com/v8/finance/chart/{ySymbol}`
  where `ySymbol` is the holding's `symbol` directly for US stocks, or
  looked up in `symbol-map.ts` for `stocks_my`/`stocks_sg` (returns
  `null` if unmapped).
- Reads `result[0].meta.regularMarketPrice` and
  `result[0].meta.chartPreviousClose` from the response; `change_pct =
  (regularMarketPrice - chartPreviousClose) / chartPreviousClose *
  100`.

### `price-fetcher/crypto.ts`

- `GET https://api.coingecko.com/api/v3/simple/price?ids={ids}&vs_currencies=usd&include_24hr_change=true`
  where `ids` maps `BTC -> bitcoin`, `ETH -> ethereum`, `BETH ->
  binance-staked-eth`.
- Quote currency is always USD from this endpoint; converted to SGD
  the same way as any other USD-denominated holding via `toSGD`.

## Data model

One new nullable column on the existing `holdings` table (no new
table), plus a corresponding Drizzle migration:

```typescript
export const holdings = sqliteTable('holdings', {
  // ...existing columns unchanged...
  broker: text('broker'), // 'ibkr' | 'moomoo' | null (null = manually entered)
});
```

`asset_class`, `currency`, `market`, `quantity`, `cost_basis` already
match this design's needs — no other schema change.

## Bot wiring

### PDF upload

New `src/bot/handlers/document.ts`:

```typescript
handleDocumentMessage(fileId: string, mimeType: string): Promise<string>
```

- Rejects non-PDF `mimeType` immediately with a friendly message (no
  Gemini call for a file that can't be a statement).
- Downloads the file via grammy's `ctx.api.getFile` / file URL,
  buffers it, calls `parseStatement`, then `replaceHoldingsForBroker`.
- Replies with a before/after summary: broker detected, holdings
  count, and the resulting portfolio net worth (calls
  `getPortfolioSummary()` after replacing, so the user sees the
  updated total immediately without a separate `/portfolio` call).
- `src/bot/index.ts` registers `this.bot.on('message:document', ...)`
  alongside the existing `message:text`/`message:voice` handlers.

### `/portfolio` command

`src/bot/commands/portfolio.ts`'s `handlePortfolioCommand` calls
`getPortfolioSummary()` and formats net worth, allocation by class,
allocation by currency, and per-holding movement — replacing the
current hardcoded placeholder string. Empty state ("no holdings yet —
upload a statement or add crypto/cash") when there are zero holdings.

### NL intent for crypto/cash

- `src/bot/types.ts`: `BotIntent` gains `'holdings'`.
- `src/bot/ai.ts`: `ExtractedFields` gains `symbol?: string` and
  `assetClass?: string`; the classifier's system instruction is
  extended to recognize holding statements ("I hold 0.5 BTC", "cash
  SGD 5000", "remove BTC") and allowed intents grows to include
  `holdings`.
- `buildAssistantReply`, new `case 'holdings'`: dynamically imports
  `../../portfolio/service` (same lazy-import pattern as `budget`/
  `correction`) and calls `addHolding`/`removeHolding` based on
  `extracted.action`, replying with confirmation.

## Testing

`src/portfolio/*.test.ts`, registered in `package.json`'s `test`
script:

- `calculator.test.ts`: net worth sums correctly across mixed
  currencies/classes; a holding with no `quote` contributes 0 without
  throwing; cash holdings value at `quantity * 100` cents directly;
  allocation percentages sum to 100 (within rounding).
- `service.test.ts` (Drizzle test-db pattern, matching
  `budget/service.test.ts`): `replaceHoldingsForBroker` wipes only the
  target broker's rows, leaves the other broker and manual entries
  untouched; `addHolding`/`removeHolding` only ever touch `broker IS
  NULL` rows; replacing with an empty array is rejected (parse-failure
  guard lives in the parser, but the service also refuses a
  zero-length replace defensively).
- `statement-parser.test.ts`: stubs `global.fetch` with a captured
  Gemini multimodal response shape (same pattern as `ai.test.ts`) to
  verify JSON-to-`ParsedStatement` mapping and broker detection; a
  malformed/empty response throws `StatementParseError`.
- `price-fetcher.test.ts`: stubs `global.fetch` with real Yahoo chart
  API and CoinGecko response shapes (captured from their public docs)
  to verify price/change_pct extraction and the in-memory TTL cache
  (second call within TTL doesn't re-fetch); an unmapped MY symbol
  returns `null` without calling fetch.
- No live-network test is added for price fetchers (unlike
  `ai.test.ts`'s opt-in live Gemini test) — these aren't the
  Gemini-first special case the project treats specially, and a broken
  Yahoo/CoinGecko response shape is better caught by fixture-based
  tests than a flaky live call in CI.

## Out of scope

- Automatic MY/SG stock symbol resolution — the mapping table is
  manually maintained; this design does not attempt to derive Bursa or
  SGX codes from company names.
- Cost basis / gain-loss tracking — `cost_basis` stays optional and
  unused by this design; a future task could compute unrealized P&L
  from it.
- Buy/sell transaction history — holdings are point-in-time snapshots
  (from statements) or fixed manual quantities (crypto/cash), not a
  ledger.
- Validating the extraction prompt against real IBKR/Moomoo PDFs — see
  the "Sample statements not yet provided" scope decision above.
