# PLUTO-06: Daily Digest — Design

Source requirements: [doc/tasks/06-daily-digest.md](../../../doc/tasks/06-daily-digest.md)

## Goal

A scheduled job that fires every night at 10 PM SGT and sends a
consolidated financial snapshot (today's spending, budget health,
recurring transactions that fired today, and a personal one-liner) to
the user via Telegram. Must still send if any individual data source
fails.

## Scope decisions (resolved during brainstorming)

- **Portfolio (PLUTO-04) doesn't exist yet.** No `getPortfolioSummary`/
  `getDailyMovement` anywhere in the codebase — only a stub
  `/portfolio` command and unused types. Rather than building a
  portfolio module here (out of scope for "06"), the aggregator calls
  a portfolio data source that always fails, and the formatter renders
  `Portfolio: unavailable (not yet implemented)`. This exercises the
  same graceful-degradation code path a real future failure would use,
  and the section lights up automatically once PLUTO-04 lands — no
  digest-side change needed then beyond swapping the stub call for the
  real one.
- **Recurring transactions must not be re-fired.** `fireRecurringForToday()`
  in `src/expense/service.ts` INSERTS a new transaction row every time
  it's called; the midnight recurring scheduler
  (`src/scheduler/recurring.ts`) already calls it once daily. The
  digest must not call it again at 10pm — it would double-log. Instead
  a new read-only `getRecurringFiredToday()` queries transactions
  already persisted today with `source = 'recurring'`.
- **Category transaction counts.** The task doc requires "transaction
  count per category," which `SpendingSummary.byCategory` (amounts
  only) doesn't carry. `SpendingSummary` gains an additive
  `byCategoryCount: Record<string, number>` field, computed in the
  same loop `getSpendingSummary` already runs over all rows. This is
  backward compatible — `/today`, `/month`, and existing tests only
  read the fields they already use.
- **One-liner summary is AI-generated**, not rule-based (the doc's
  stated default), per explicit direction. Uses the same
  `GoogleGenerativeAI` client pattern as `src/bot/ai.ts`
  (`gemini-3.6-flash`, short timeout, try/catch). Because this adds a
  new failure surface to a job that must degrade gracefully, a failed
  or timed-out call falls back to a small rule-based line (not a
  digest-wide failure) — the AI call's own error is caught locally in
  `summary.ts`, not left to the outer aggregator's degradation
  handling.
- **Timezone**: `node-cron`'s `schedule()` accepts a `{ timezone }`
  option (confirmed in `node_modules/node-cron/dist/*.d.ts`), so
  `cron.schedule('0 22 * * *', fn, { timezone: 'Asia/Singapore' })`
  needs no manual offset math.
- **No catch-up-on-startup.** Unlike the recurring scheduler (which
  calls `triggerRecurringNow` once at boot to cover downtime), the
  digest doc explicitly says a missed 10pm run is skipped, not
  backfilled — so `src/index.ts` only starts the cron job, no extra
  boot-time call.
- **Manual trigger**: adds a `/digest` command (not in the original
  doc, added per explicit direction) so the message can be checked
  without waiting for 10pm, mirroring the existing command pattern and
  `triggerRecurringNow`.

## Module layout

```
src/digest/
├── index.ts     # startDigestScheduler, stopDigestScheduler, triggerDigestNow, buildDigestMessage
├── aggregator.ts# collectDigestData() — pulls from expense/budget/portfolio(stub) via Promise.allSettled
├── formatter.ts # formatDigestMessage(data) — builds the message string
├── summary.ts   # generateSummaryLine(data) — Gemini call + rule-based fallback
└── types.ts     # DigestData and section-result types
```

### `types.ts`

```typescript
type SectionResult<T> = T | { error: string };

interface DigestData {
  spending: SectionResult<SpendingSummary>;
  recurringFired: SectionResult<Transaction[]>;
  budgetStatuses: SectionResult<BudgetStatus[]>;
  portfolio: { error: string }; // always this shape until PLUTO-04 exists
}
```

### `aggregator.ts`

```typescript
collectDigestData(): Promise<DigestData>
```

Runs `getSpendingSummary('today')`, `getRecurringFiredToday()`, and
`getBudgetStatus()` via `Promise.allSettled`, mapping each settled
result to its value or `{ error: <message> }`. `portfolio` is always
`{ error: 'not yet implemented' }` — no call is actually made, since
there is nothing to call. Logs each failure at `warn` level with the
section name, per the doc's "log the error for debugging" requirement.

### `formatter.ts`

```typescript
formatDigestMessage(data: DigestData, summaryLine: string): string
```

Builds the message per the template below. Each section checks its
`SectionResult` shape: an `{ error }` value renders
`{Section}: unavailable ({error})`; otherwise it renders the normal
lines. Money formatting follows the existing inline convention
(`S$${(cents / 100).toFixed(2)}`, same as `handleTodayCommand`/
`handleBudgetCommand`) — no new shared formatter introduced.

### `summary.ts`

```typescript
generateSummaryLine(data: DigestData): Promise<string>
```

Builds a short prompt from the digest data (today's total, top
category, any budget ≥80%) and calls Gemini
(`gemini-3.6-flash`, ~5s timeout — shorter than `ai.ts`'s 15s since
this isn't blocking a user's chat reply) for a one-line personal
comment. On any failure (timeout, network, empty response), falls back
to a rule-based line: `"Watch {category} spending."` if any budget
status is ≥80%, else `"All good."`.

### `index.ts`

```typescript
startDigestScheduler(bot: Bot | null): void
stopDigestScheduler(): void
triggerDigestNow(bot: Bot | null): Promise<void>
buildDigestMessage(): Promise<string>
```

Same shape as `src/scheduler/recurring.ts`: `startDigestScheduler`
guards against double-start, schedules
`cron.schedule('0 22 * * *', fn, { timezone: 'Asia/Singapore' })`.
`triggerDigestNow` calls `buildDigestMessage()` then sends via
`bot.api.sendMessage(config.TELEGRAM_AUTHORIZED_CHAT_ID, text)`,
skipping with a logged warning if `bot` is null or
`TELEGRAM_AUTHORIZED_CHAT_ID` isn't configured — matching
`deliverBudgetAlerts`'s existing guard pattern.

## Data flow & graceful degradation

Each of the three real sources (spending, recurring, budgets) is
independent — a failure in one never prevents the others from
rendering, and never prevents the digest from sending. The portfolio
section is a permanent `{ error }` stub until PLUTO-04 exists. If
`sendMessage` itself throws, that's logged and surfaced like any other
Telegram delivery failure (matching how `deliverBudgetAlerts` handles a
`sendMessage` throw per-transaction) — the whole digest simply doesn't
send that night, consistent with "missed 10pm digest is skipped."

## Message format

```
Daily Digest - 28 Aug 2026

Spent today: S$45.20
  Food: S$25.00 (2 txns)
  Transport: S$20.20 (1 txn)

Auto-logged: S$15.00 Netflix (recurring)

Budget: Food 62.5% used (3 days left)

Portfolio: unavailable (not yet implemented)

{AI one-liner, or rule-based fallback}
```

- No spending today → `Spent today: S$0.00 — no spending today.`
  (single line, no per-category breakdown).
- No recurring fired today → the `Auto-logged` block is omitted
  entirely (empty state, not an error).
- No budgets set → the `Budget` block is omitted entirely (empty
  state, not an error — matches `/budget`'s existing "no budgets set"
  being a valid empty state).
- A genuinely failed section (spending/recurring/budgets) renders as
  `{Section}: unavailable ({reason})` instead of being omitted, so a
  real failure stays visible and distinct from "nothing to show."

## Bot & scheduler wiring

- `src/index.ts`: after `startRecurringScheduler(...)`, adds
  `startDigestScheduler(plutoBot ? plutoBot.getBot() : null)`. No
  boot-time catch-up call (see scope decision above).
- `src/bot/commands/digest.ts`: `handleDigestCommand()` calls
  `buildDigestMessage()` directly and returns the text as the command
  reply (does not go through `triggerDigestNow`'s scheduled-send path,
  so it works standalone without depending on
  `TELEGRAM_AUTHORIZED_CHAT_ID` matching the calling chat).
- `src/bot/index.ts`: registers `this.bot.command('digest', ...)`
  alongside the other commands.
- `src/bot/formatter/messages.ts`: `formatHelpMessage()` gains a
  `/digest - preview tonight's digest` line.

## Data model

No schema changes. `getRecurringFiredToday()` is a new read-only query
against the existing `transactions` table (same raw-`better-sqlite3`
pattern as the rest of `src/expense/service.ts`, per the module's
established convention):

```sql
SELECT * FROM transactions
WHERE source = 'recurring' AND created_at >= ?
ORDER BY created_at DESC
```

(`?` = start-of-today timestamp, same `startOfPeriod('today')` helper
already used by `getSpendingSummary`.)

## Testing

`src/digest/digest.test.ts`, added to `package.json`'s `test` script:

- `collectDigestData` returns real data for all sections when every
  source succeeds.
- `collectDigestData` degrades a single failing source (stub it to
  reject) to `{ error }` without throwing or affecting the other
  sections.
- `formatDigestMessage` renders "no spending today" copy when
  `spending.total === 0`.
- `formatDigestMessage` omits the `Budget` block when
  `budgetStatuses` is an empty array, and omits `Auto-logged` when
  `recurringFired` is empty.
- `formatDigestMessage` renders `Portfolio: unavailable (...)` for the
  permanent portfolio stub.
- `getRecurringFiredToday` (in `src/expense/expense.test.ts` or a new
  section of `digest.test.ts`) returns only transactions with
  `source = 'recurring'` created today, and does not insert anything
  (call twice, assert no growth).
- `generateSummaryLine` falls back to the rule-based line when the
  Gemini call fails (stub `global.fetch` to reject, same pattern as
  `src/bot/ai.test.ts`'s "Gemini call fails" case — runs by default,
  no live API key needed).

## Out of scope

- Real portfolio data (PLUTO-04) — the section stays a permanent stub
  until that module is built; no attempt to implement even a minimal
  portfolio service here.
- Backfilling a missed digest (explicitly acceptable per the task
  doc's Notes).
- Multi-user support or timezone configuration — single user,
  hardcoded `Asia/Singapore`, per the task doc.
- A shared money-formatting helper — kept consistent with the existing
  inline `(cents / 100).toFixed(2)` convention used by
  `handleTodayCommand`/`handleBudgetCommand` rather than introducing a
  new abstraction.
