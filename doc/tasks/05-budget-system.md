# PLUTO-05: Budget System

| Field | Value |
|-------|-------|
| Module | Budget System |
| Priority | P1 — High |
| Dependencies | PLUTO-01 (Project Foundation), PLUTO-03 (Expense Engine) |
| Estimated effort | Small |

---

## Description

Allows the user to set monthly spending budgets per category, tracks
progress against them, triggers alerts at thresholds (80% and 100%),
and resets monthly. Budget status is included in the daily digest.

---

## Acceptance Criteria

**Status: not started.** No `src/budget/` directory exists; `/budget`
(src/bot/commands/budget.ts) is a hardcoded placeholder string. The
`budgets` table exists in the schema but nothing reads or writes to it.
None of the criteria below are implemented.

- [ ] User can set budgets via chat: "Set food budget to $800/month"
- [ ] User can update or remove budgets
- [ ] Budget progress calculated from current month's spending in that
      category
- [ ] Alert triggered when 80% of budget is reached (sent once)
- [ ] Alert triggered when budget is exceeded (sent once)
- [ ] Budgets auto-reset on the 1st of each month (progress resets,
      budget amount persists)
- [ ] /budget command shows all budgets with current progress
- [ ] Budget status included in daily digest data

---

## Technical Scope

### Components

| Component | Responsibility |
|-----------|---------------|
| Budget service | CRUD for budget definitions |
| Progress calculator | Current spend vs budget for each category |
| Alert checker | Detect threshold crossings, fire alerts once |
| Monthly reset | Reset tracking flags on the 1st |

### Files to Create

```
src/budget/
├── index.ts              # Public API exports
├── service.ts            # Budget CRUD
├── progress.ts           # Calculate current spend vs budget
├── alerts.ts             # Threshold detection and alert firing
└── types.ts              # Module-specific types
```

### Alert Logic

```
On every new transaction:
  1. Check if transaction's category has a budget
  2. Calculate current month spend in that category
  3. If spend >= 80% of budget AND 80% alert not yet sent → alert
  4. If spend >= 100% of budget AND 100% alert not yet sent → alert
  5. Store alert-sent flags (reset monthly)
```

Alert flags stored in a simple table:
```sql
budget_alerts (
  budget_id, threshold, sent_at, month
)
```

---

## Interface Contracts

### Exposes

```typescript
setBudget(category: Category, amount: number, currency?: Currency): Promise<Budget>
removeBudget(category: Category): Promise<void>
listBudgets(): Promise<Budget[]>

getBudgetStatus(): Promise<BudgetStatus[]>

interface BudgetStatus {
  category: Category
  budget_amount: number
  budget_currency: Currency
  budget_sgd: number
  spent_sgd: number
  percentage: number
  remaining_sgd: number
  days_left_in_month: number
}

checkAlerts(transaction: Transaction): Promise<Alert | null>
```

### Consumes

```typescript
// From Expense Engine (PLUTO-03)
getSpendingByCategory(period: 'month'): Promise<CategoryBreakdown[]>

// From Foundation (PLUTO-01)
import { db } from '../db'
```

---

## Notes

- Budgets are monthly only in V1 (no weekly or custom periods).
- Alert messages are sent via the Telegram bot — this module returns
  the alert data, the bot module handles delivery.
- "Days left in month" helps the user gauge if they're on track
  (e.g., "62% used with 19 days left" = comfortable).
- Budget amounts store original currency (e.g. RM500) and a
  pre-computed SGD equivalent for comparison against spending.
- If no currency specified, defaults to SGD.
