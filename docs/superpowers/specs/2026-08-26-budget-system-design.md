# PLUTO-05: Budget System — Design

Source requirements: [doc/tasks/05-budget-system.md](../../../doc/tasks/05-budget-system.md)

## Goal

Let the user set monthly spending budgets per category, see progress
against them, and get alerted once at 80% and once at 100% of a
budget. `/budget` shows current status; the existing free-text
"budget" chat intent actually sets/removes budgets instead of
returning a canned reply.

## Scope decisions (resolved during brainstorming)

- **Persistence:** the new module uses the Drizzle query builder
  (`src/db/client.ts`) against the existing `budgets` table, not the
  expense module's raw-`better-sqlite3` pattern. This is a deliberate
  second access style for new code only — the expense module is not
  touched or migrated.
- **NL wiring:** the `budget` intent in `src/bot/ai.ts` is wired to
  call the real budget service (mirroring how the existing
  `correction` intent already dynamically imports and calls
  `correctLastTransaction`), rather than staying a canned reply like
  the still-unwired `expense` intent.
- **Alert delivery:** wired live now, not left as data-only. The only
  production code path that currently creates transactions is the
  recurring-transaction scheduler (`fireRecurringForToday`, run
  nightly by cron) — the free-text `expense` intent is not wired to
  `logExpense` yet (pre-existing, out of scope here). Alerts are
  therefore hooked into the scheduler's post-fire step. When the
  `expense` intent is wired to `logExpense` in a future task, the same
  `checkAlerts` call slots in there too.
- **No separate "monthly reset" job.** The task doc's file list
  includes a "Monthly reset" component; this design drops it.
  `getBudgetStatus()` always computes spend live from the current
  month's transactions, and alert dedup rows are keyed by month, so a
  new month naturally has zero spend and zero alert rows — satisfying
  "progress resets, budget amount persists" with no scheduled job.

## Module layout

```
src/budget/
├── index.ts     # public exports
├── types.ts     # Budget, BudgetStatus, Alert (module-local)
├── service.ts   # setBudget, removeBudget, listBudgets (Drizzle CRUD)
├── progress.ts  # getBudgetStatus()
└── alerts.ts    # checkAlerts(transaction)
```

### `service.ts`

```typescript
setBudget(category: Category, amount: number, currency?: Currency): Promise<Budget>
removeBudget(category: Category): Promise<void>
listBudgets(): Promise<Budget[]>
```

- One budget per category: `setBudget` upserts by `category` (updates
  the existing row if one exists for that category, else inserts).
- `amount` is in dollars on input (matching `ExpenseInput.amount`'s
  convention), converted to integer cents internally.
- `currency` defaults to `'SGD'` if omitted. `amount_sgd` is computed
  via `toSGD` from `src/config/currencies.ts` (the same static-rate
  helper the expense engine uses).
- Uses `db` from `src/db/client.ts` and the `budgets` Drizzle table
  from `src/db/schema.ts` (already defined, no schema change needed).

### `progress.ts`

```typescript
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
```

- For each row from `listBudgets()`, get month-to-date spend for that
  category via `getSpendingByCategory('month')` from
  `src/expense/service.ts` (already exported, per the interface
  contract in the task doc).
- `days_left_in_month` computed from `new Date()` — days in the
  current month minus the current day.

### `alerts.ts`

```typescript
checkAlerts(transaction: Transaction): Promise<Alert | null>

interface Alert {
  budget_id: string
  category: Category
  threshold: 80 | 100
  message: string
}
```

- Pure w.r.t. delivery: no Telegram/bot dependency. Looks up the
  transaction's category budget (if none, returns `null`), computes
  current month spend for that category, and checks the **highest**
  threshold newly crossed (100 before 80, so a transaction that jumps
  straight past both only fires the 100% alert).
- Dedup via a new `budget_alerts` table (see below): before returning
  an alert for a threshold, checks whether a row already exists for
  `(budget_id, threshold, current_month)`; if not, inserts one and
  returns the alert; if it exists, that threshold is skipped.
- If both thresholds are unfired and spend crosses 100% in one jump,
  both alert rows are inserted, but only one `Alert` (the 100%
  message) is returned to keep "sent once" semantics simple — the doc
  doesn't require both a "you've hit 80%" and "you've hit 100%"
  message to fire back-to-back for a single transaction that clears
  both. If this ordering is later found to matter, revisit.

## Data model

New Drizzle table in `src/db/schema.ts`, and a corresponding migration
(`npx drizzle-kit generate`, consistent with how the existing `budgets`
migration was produced):

```typescript
export const budget_alerts = sqliteTable('budget_alerts', {
  id: text('id').primaryKey(),
  budget_id: text('budget_id').notNull().references(() => budgets.id),
  threshold: integer('threshold').notNull(), // 80 or 100
  month: text('month').notNull(),            // 'YYYY-MM'
  sent_at: integer('sent_at').notNull().default(sql`(unixepoch() * 1000)`),
});
```

No schema change needed for `budgets` — it already exists and matches
`src/types/budget.ts`'s `Budget` shape.

## Bot wiring

### `/budget` command

`src/bot/commands/budget.ts`'s `handleBudgetCommand` calls
`getBudgetStatus()` and formats each category as a line (spent /
limit, percentage, days left), matching the existing style of
`handleTodayCommand`/`handleMonthCommand`. Empty state ("no budgets
set yet") when the list is empty.

### NL intent

`src/bot/ai.ts`'s `buildAssistantReply`, `case 'budget'`: dynamically
imports `../../budget/service` (same lazy-import pattern already used
in the `correction` case to avoid module-load-order issues) and:

- If `extracted.action` indicates removal (e.g. contains "remove" /
  "delete" — mirrors how `correction` infers intent from extracted
  fields) → `removeBudget(category)`.
- Otherwise → `setBudget(category, budgetAmount ?? amount, ...)`.
- Replies confirming the action using the returned `Budget`/void
  result, instead of the current canned acknowledgement string.

### Alert push

`src/scheduler/recurring.ts`:

- `startRecurringScheduler` and `triggerRecurringNow` take a `Bot`
  (grammy) parameter, used to send messages.
- After `fireRecurringForToday()` returns its created transactions,
  loop each and call `checkAlerts(txn)`; if non-null, call
  `bot.api.sendMessage(config.TELEGRAM_AUTHORIZED_CHAT_ID, alert.message)`.
- If `TELEGRAM_AUTHORIZED_CHAT_ID` is not configured, log a warning
  once per check and skip sending (there is no known chat to push to).

`src/index.ts` passes its `PlutoBot` instance's underlying `Bot` (via
a new `getBot()` accessor — already present on `PlutoBot`) into
`startRecurringScheduler`/`triggerRecurringNow`. If
`TELEGRAM_BOT_TOKEN` isn't configured (no bot started), the scheduler
still runs recurring transactions but skips alert delivery (no bot to
send through) and logs a warning.

## Testing

`src/budget/budget.test.ts` (registered in `package.json`'s `test`
script alongside the existing two files), using the same
delete-and-recreate test-db pattern as
`src/expense/expense.test.ts`:

- `setBudget` creates a budget with correct cents/SGD conversion.
- `setBudget` on an existing category updates rather than duplicates.
- `removeBudget` deletes the row.
- `listBudgets` returns all budgets.
- `getBudgetStatus` computes percentage/remaining/days-left correctly
  against seeded transactions.
- `checkAlerts` returns `null` when there's no budget for the
  transaction's category.
- `checkAlerts` fires once at 80%, not again on a subsequent
  transaction still under 100%.
- `checkAlerts` fires the 100% alert once when spend crosses it.
- A transaction in a new month re-fires alerts (dedup is
  month-scoped).

## Out of scope

- Wiring the `expense` chat intent to `logExpense` (pre-existing gap,
  not introduced or required by this task).
- Weekly/custom budget periods (V1 is monthly only, per the task doc).
- Live exchange rates (`src/config/exchange-rates.ts` is not wired
  into the expense engine yet either; budgets stay consistent with the
  expense engine's current static-rate `toSGD`).
