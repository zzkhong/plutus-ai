# PLUTO-06: Daily Digest

| Field | Value |
|-------|-------|
| Module | Daily Digest |
| Priority | P1 — High |
| Dependencies | PLUTO-01 (Foundation), PLUTO-03 (Expense Engine), PLUTO-04 (Portfolio Tracker), PLUTO-05 (Budget System) |
| Estimated effort | Small-Medium |

---

## Description

A scheduled job that fires every night at 10 PM SGT and sends a
consolidated financial snapshot to the user via Telegram. Combines
today's spending, budget health, portfolio net worth, and notable market
movements into a single concise message.

---

## Acceptance Criteria

**Status: not started.** No `src/digest/` directory exists, and there is
no `node-cron` usage anywhere in `src/` despite it being a dependency.
None of the criteria below are implemented.

- [ ] Scheduler fires at 10 PM SGT daily (Asia/Singapore timezone)
- [ ] Message includes today's total spending broken down by category
- [ ] Message includes transaction count per category
- [ ] Message includes budget status for any category with a budget set
- [ ] Message includes portfolio net worth in SGD
- [ ] Message includes notable stock/crypto movements (> 1% change)
- [ ] Message includes any recurring transactions that fired today
- [ ] Message is concise, well-formatted, and easy to scan
- [ ] If no spending today, message acknowledges it ("No spending
      today")
- [ ] Digest still sends even if one data source fails (graceful
      degradation)

---

## Technical Scope

### Components

| Component | Responsibility |
|-----------|---------------|
| Scheduler | node-cron job at 10 PM SGT |
| Data aggregator | Pulls data from Expense, Portfolio, Budget modules |
| Message builder | Formats the digest message |
| Sender | Delivers via Telegram bot |

### Files to Create

```
src/digest/
├── index.ts              # Scheduler setup and trigger
├── aggregator.ts         # Collect data from all modules
├── formatter.ts          # Build the digest message string
└── types.ts              # Module-specific types
```

### Message Format

```
Daily Digest - {date}

Spent today: ${total}
  {category}: ${amount} ({count} txns)
  {category}: ${amount} ({count} txns)

{if recurring fired today}
Auto-logged: ${amount} {merchant} (recurring)
{/if}

{if budgets exist}
Budget: {category} {pct}% used ({days_left} days left)
{/if}

Net Worth: ${net_worth} SGD
  Stocks: {+/-}{change_pct}% today
  Crypto: BTC ${price} ({+/-}{change_pct}%)

{one-liner summary: "All good." / "Watch food spending." / etc.}
```

### Graceful Degradation

If any data source fails (e.g., price API is down):
- Still send the digest with available data
- Mark failed sections: "Portfolio: unavailable (price fetch failed)"
- Log the error for debugging

---

## Interface Contracts

### Consumes

```typescript
// From Expense Engine (PLUTO-03)
getSpendingSummary('today'): Promise<SpendingSummary>
fireRecurringForToday(): Promise<Transaction[]>

// From Portfolio Tracker (PLUTO-04)
getPortfolioSummary(): Promise<PortfolioSummary>
getDailyMovement(): Promise<Movement[]>

// From Budget System (PLUTO-05)
getBudgetStatus(): Promise<BudgetStatus[]>

// From Bot (PLUTO-02) — or direct Telegram API call
sendMessage(text: string): Promise<void>
```

### Exposes

```typescript
// Primarily internal, but expose for testing/manual trigger
triggerDigest(): Promise<void>
buildDigestMessage(): Promise<string>
```

---

## Notes

- Timezone is hardcoded to Asia/Singapore (SGT, UTC+8). Single user,
  no timezone config needed.
- The "one-liner summary" at the bottom can be AI-generated (Gemini)
  for a personal touch, or a simple rule-based line. Start with
  rule-based, upgrade to AI later if desired.
- node-cron expression: `0 22 * * *` (10 PM daily).
- If the bot was offline at 10 PM, the digest for that day is skipped
  (acceptable for personal tool).
