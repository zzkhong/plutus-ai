# PLUTO-04: Portfolio Tracker

| Field | Value |
|-------|-------|
| Module | Portfolio Tracker |
| Priority | P1 — High |
| Dependencies | PLUTO-01 (Project Foundation) |
| Estimated effort | Medium |

---

## Description

Tracks the user's investment portfolio across US stocks/ETFs, Malaysian
stocks, and crypto. Holdings are manually entered (fixed quantities).
The system fetches live market prices and calculates total net worth in
SGD, allocation percentages, and daily movements.

---

## Acceptance Criteria

**Status: implemented**, with two known gaps — see below. See
`src/portfolio/`, the wired `/portfolio` command, the statement PDF
upload flow, and the `holdings` chat intent.

- [x] User can add/remove holdings via chat ("Add 10 AAPL", "Remove
      CIMB")
- [x] US stock prices fetched from a free API (Yahoo Finance, Alpha
      Vantage, or similar)
- [ ] Malaysian stock prices fetched (Bursa Malaysia data source) —
      implemented via Yahoo Finance `.KL` symbols, but only for symbols
      present in the manually-maintained
      `src/portfolio/price-fetcher/symbol-map.ts` table; unmapped
      symbols show "price unavailable".
- [x] Crypto prices fetched for BTC, ETH, BETH (CoinGecko free tier)
- [x] Total net worth calculated in SGD with currency conversion
- [x] Allocation breakdown by asset class (US stocks, MY stocks,
      crypto, cash)
- [x] Currency exposure breakdown (SGD, MYR, USD, crypto)
- [x] Daily movement calculation (% change from previous close)
- [x] Cash balances trackable across currencies
- [x] /portfolio command returns formatted summary

**Known gap:** the Gemini statement-extraction prompt (IBKR/Moomoo PDF
upload flow) is unvalidated against real broker PDFs — no sample
statements were available during implementation. This is an explicit,
known gap documented in the design spec's "Sample statements not yet
provided" scope decision, not an oversight.

---

## Technical Scope

### Components

| Component | Responsibility |
|-----------|---------------|
| Holdings service | CRUD for stock/crypto/cash holdings |
| Price fetcher | Fetch live prices from multiple sources |
| Net worth calculator | Aggregate all holdings into SGD total |
| Allocation calculator | Percentage splits by class and currency |
| Movement tracker | Daily change calculations |

### Files to Create

```
src/portfolio/
├── index.ts                  # Public API exports
├── service.ts                # Holdings CRUD
├── price-fetcher/
│   ├── index.ts              # Unified price fetching interface
│   ├── us-stocks.ts          # Yahoo Finance / Alpha Vantage
│   ├── my-stocks.ts          # Bursa Malaysia source
│   └── crypto.ts             # CoinGecko for BTC/ETH/BETH
├── calculator.ts             # Net worth & allocation math
├── movement.ts               # Daily movement tracking
└── types.ts                  # Module-specific types
```

### Data Sources (Free Tier)

| Asset class | Source | Rate limit |
|-------------|--------|-----------|
| US stocks/ETFs | Yahoo Finance (unofficial) or Alpha Vantage (free key) | 5 req/min |
| MY stocks | TBD — Bursa data is harder to get free. Fallback: manual entry of prices | — |
| Crypto | CoinGecko free API | 10-30 req/min |
| Exchange rates | Same source as Expense Engine | Daily |

### Price Caching Strategy

- Prices cached for 15 minutes during market hours
- Cached until next market open outside hours
- Crypto cached for 5 minutes (24/7 market)
- Cache stored in DB table: `price_cache (symbol, price, currency,
  fetched_at)`

---

## Interface Contracts

### Exposes

```typescript
interface HoldingInput {
  symbol: string
  quantity: number
  asset_class: AssetClass
  market: 'US' | 'MY' | 'crypto' | 'cash'
  currency: Currency
}

addHolding(data: HoldingInput): Promise<Holding>
removeHolding(symbol: string): Promise<void>
updateHolding(symbol: string, quantity: number): Promise<Holding>
listHoldings(): Promise<Holding[]>

getPortfolioSummary(): Promise<PortfolioSummary>
getNetWorth(): Promise<{ total_sgd: number; breakdown: AssetBreakdown[] }>
getAllocation(): Promise<{ by_class: Allocation[]; by_currency: Allocation[] }>
getDailyMovement(): Promise<Movement[]>

interface PortfolioSummary {
  net_worth_sgd: number
  by_class: { class: AssetClass; value_sgd: number; pct: number }[]
  by_currency: { currency: Currency; value_sgd: number; pct: number }[]
  movements: { symbol: string; change_pct: number }[]
}
```

### Consumes

```typescript
// From Foundation (PLUTO-01)
import { db } from '../db'
import { convertToSGD } from '../utils/currency'
```

---

## Notes

- Crypto holdings are fixed quantities — no buy/sell tracking. User
  enters "I hold 0.5 BTC" once and the system just tracks price.
- BETH (Binance staked ETH) may need to be treated as ETH * a ratio
  or fetched separately from CoinGecko.
- Malaysian stock data is the hardest to get for free. Acceptable
  fallback: user manually updates MY stock prices, or we scrape a
  public page.
- Net worth = sum of (quantity * price * exchange_rate_to_SGD) for all
  holdings.
- Cash balances are just holdings with quantity = amount and price = 1.
