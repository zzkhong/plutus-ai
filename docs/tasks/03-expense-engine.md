# PLUTO-03: Expense Engine

| Field | Value |
|-------|-------|
| Module | Expense Engine |
| Priority | P0 — Critical Path |
| Dependencies | PLUTO-01 (Project Foundation) |
| Estimated effort | Large |

---

## Description

The core transaction processing engine. Handles logging expenses from
all input channels (Apple Pay automation, manual text, voice), AI-powered
categorization, currency detection and conversion, corrections, and
querying spending data. This is the largest and most critical module.

---

## Acceptance Criteria

- [x] Transactions are persisted with amount, currency, merchant,
      category, source, and SGD-normalized value
- [x] AI categorization works with Singlish/Malaysian context (kopi =
      Food, grab = Transport)
      (Now uses Gemini via src/expense/categorizer.ts - async inferCategory()
      with Singapore/Malaysia-specific prompts and fallback to 'Others')
- [ ] Currency detection from card name mapping (DBS Visa = SGD,
      Maybank = MYR)
      (DEFAULT_CARD_CURRENCY_MAP in src/config/currencies.ts has an
      entry for DBS → SGD but no Maybank entry, so the MYR half of this
      example isn't satisfied — update the map to add Maybank → MYR)
- [x] Currency detection from explicit mention ("RM45", "$4.50")
- [x] All amounts converted to SGD using live or cached exchange rates
      (Exchange rate service with placeholder in src/config/exchange-rates.ts;
      static fallback rates in src/config/currencies.ts; ready for API
      integration with exchangerate-api.com or Google Sheets)
- [x] /undo removes the last transaction and confirms
- [x] Corrections via natural language ("last one was transport not
      food") update the record
      (Wired in src/bot/ai.ts buildAssistantReply - correction intent
      calls correctLastTransaction() dynamically)
- [x] Spending queries return accurate aggregations (today, this week,
      this month, by category)
- [x] Recurring transactions auto-log on their scheduled day
      (Scheduler in src/scheduler/recurring.ts runs daily at 00:00 via
      node-cron; startup recovery fires missed transactions; started in
      src/index.ts)
- [ ] Recurring management (create, pause, remove, list)
      (createRecurring/pauseRecurring/removeRecurring/listRecurring all
      exist in src/expense/service.ts, but there is no bot command or
      chat flow that exposes them — a user has no way to actually manage
      recurring transactions yet)

---

## Technical Scope

### Components

| Component | Responsibility |
|-----------|---------------|
| Transaction service | CRUD for transactions, query aggregations |
| Categorizer | AI-powered expense categorization via Gemini |
| Currency resolver | Detect currency from card/text, convert to SGD |
| Recurring scheduler | Fire recurring transactions on schedule |
| Correction handler | Parse corrections, update existing records |
| Export service | Generate CSV for a given period |

### Files to Create

```
src/expense/
├── index.ts                  # Public API exports
├── service.ts                # Transaction CRUD and queries
├── categorizer.ts            # Gemini-based categorization
├── currency-resolver.ts      # Currency detection + conversion
├── recurring.ts              # Recurring transaction scheduler
├── corrections.ts            # Handle "last one was X" corrections
├── export.ts                 # CSV export generation
├── queries/
│   ├── spending-summary.ts   # Today/week/month aggregations
│   └── search.ts             # Free-form query support
└── types.ts                  # Module-specific types
```

### AI Categorization Prompt Design

The categorizer sends merchant name + amount + context to Gemini with a
system prompt that:
- Returns one of the predefined categories
- Understands local context (hawker = Food, MRT = Transport, etc.)
- Handles ambiguity conservatively (asks user if unsure)

**Categories:**
Food, Transport, Shopping, Entertainment, Bills, Health, Education,
Travel, Groceries, Others

### Currency Resolution Logic

```
1. If source is Apple Pay automation → use card-to-currency mapping
2. If explicit currency symbol in text (RM, $, USD) → use that
3. If merchant context suggests currency → use that
4. Default → SGD
```

### Exchange Rate Fetching

- Use a free API (exchangerate-api.com free tier or similar)
- Cache rates daily (personal use doesn't need real-time)
- Store the rate used at time of transaction for auditability

---

## Interface Contracts

### Exposes

```typescript
interface ExpenseInput {
  amount: number
  currency?: Currency
  merchant?: string
  cardName?: string
  note?: string
  source: 'apple_pay' | 'text' | 'voice'
}

logExpense(data: ExpenseInput): Promise<Transaction>
undoLastTransaction(): Promise<Transaction | null>
correctLastTransaction(field: string, value: string): Promise<Transaction>

getSpendingSummary(period: 'today' | 'week' | 'month'): Promise<SpendingSummary>
getSpendingByCategory(period: string): Promise<CategoryBreakdown[]>
getTopExpenses(period: string, limit: number): Promise<Transaction[]>
compareSpending(period1: string, period2: string): Promise<Comparison>

createRecurring(data: RecurringInput): Promise<RecurringTransaction>
pauseRecurring(id: string): Promise<void>
removeRecurring(id: string): Promise<void>
listRecurring(): Promise<RecurringTransaction[]>
fireRecurringForToday(): Promise<Transaction[]>

exportCSV(year: number): Promise<string> // returns file path
```

### Consumes

```typescript
// From Foundation (PLUTO-01)
import { db } from '../db'
import { config } from '../config'
import { convertToSGD } from '../utils/currency'
```

---

## Notes

- Exchange rates are now managed by src/config/exchange-rates.ts with
  in-memory caching (24-hour TTL), ready for API integration
  (exchangerate-api.com, Google Sheets, or other providers).
- Recurring transactions fire via node-cron at midnight (src/scheduler/recurring.ts).
  On startup, missed transactions are fired via triggerRecurringNow().
- The categorizer now uses Gemini Flash via async inferCategory() with
  Singapore/Malaysia-specific context and fallback to 'Others'.
- CSV export writes to a temp file and sends via Telegram's document
  API.
- All amounts stored as integers (cents/sen) — e.g., $4.50 = 450.
