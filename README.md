# Plutus AI — Personal Finance AI Assistant

A Telegram-first personal finance assistant. It logs expenses (typed, spoken,
or auto-captured from Apple Pay), tracks budgets, and sends a nightly
AI-written spending digest — all backed by a local SQLite database. Message
understanding is **Gemini-first with no rule-based fallback**: the bot calls
Gemini to classify every free-text message, and a Gemini call failure surfaces
as a graceful error rather than falling back to keyword matching.

## Status

| Module | State |
|---|---|
| Foundation (config, db, logger) | ✅ Done |
| Telegram bot shell + commands | ✅ Done |
| Expense engine (`/today`, `/month`, `/export`, `/undo`) | ✅ Done |
| Budget system (`/budget`, natural-language "set food budget to $800") | ✅ Done |
| Daily digest (`/digest`, 10pm SGT cron) | ✅ Done |
| iOS Shortcuts webhook (Apple Pay auto-logging) | ✅ Done |
| Portfolio tracker (`/portfolio`) | 🚧 Stub — returns a placeholder string |
| Free-text "expense" intent → `logExpense` | 🚧 Not wired — Gemini classifies it correctly but the reply is an acknowledgement only; it does not persist a transaction yet. Use `/today`'s underlying flow, the iOS Shortcut webhook, or natural-language budget/correction messages, which *are* wired, to actually write rows. |

See [docs/tasks/](docs/tasks/) for the module-by-module build plan. (The
product spec that used to live at `doc/pluto-ai-prd.md` was deleted in commit
`f6531e4` and hasn't been re-added — there's currently no PRD file in the
repo.)

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + TypeScript |
| Database | SQLite (`better-sqlite3`) |
| ORM | Drizzle ORM (canonical schema — see caveat below) |
| AI model | Google Gemini (`gemini-3.6-flash`, pinned) |
| Bot framework | Grammy (Telegram) |
| HTTP server | Hono (iOS Shortcuts webhook) |
| Scheduler | node-cron |
| Validation | Zod |
| Dev tools | tsx, ESLint (flat config), Prettier |

## Prerequisites

- Node.js 18+ and npm
- A **Google API key** with Gemini access — [aistudio.google.com/apikey](https://aistudio.google.com/apikey). This is **required**; the app refuses to start without it (no rule-based fallback exists). The free tier is rate-limited (20 requests/day at the time of writing), which is enough for personal use but can throttle test runs — see [Testing](#testing).
- A **Telegram bot token** from [@BotFather](https://t.me/BotFather) — optional; without it the app still runs (db, scheduler, webhook) but the Telegram bot itself doesn't start.
- (Optional) `cloudflared`, only if you want the iOS Shortcuts webhook reachable from your phone — see [docs/setup/ios-shortcut-setup.md](docs/setup/ios-shortcut-setup.md).

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:

```env
NODE_ENV=development
TZ=Asia/Singapore
DATABASE_URL=./data/pluto.db
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_AUTHORIZED_CHAT_ID=your_telegram_chat_id_here
GOOGLE_API_KEY=your_google_api_key_here
LOG_LEVEL=info
PORT=3000
WEBHOOK_API_KEY=your_webhook_shared_secret_here
```

Notes:
- `GOOGLE_API_KEY` is the only variable startup fails without (validated in [src/config/env.ts](src/config/env.ts)).
- `TZ=Asia/Singapore` is required so "today" boundaries (expense summaries, budget periods, the digest) line up with the digest's 10pm SGT cron schedule.
- `TELEGRAM_AUTHORIZED_CHAT_ID` restricts the bot to a single chat ([src/bot/middleware/auth.ts](src/bot/middleware/auth.ts)); leaving it unset means auth is open to any chat that finds your bot — fine for local testing, not for anything left running.
- `WEBHOOK_API_KEY` gates the iOS Shortcuts endpoint (`POST /api/apple-pay`); the webhook server refuses to start without it, since it's meant to be exposed to the internet via a tunnel.
- The database file and its tables are created automatically on first run — no separate `db:migrate` step is required to get started (Drizzle migrations in `src/db/migrations/` exist for schema evolution, not first-time setup).

### 3. Run it

```bash
npm run dev
```

You should see log lines for: database initialized, Telegram bot started (if
`TELEGRAM_BOT_TOKEN` is set), recurring-transaction scheduler running, digest
scheduler running, and the webhook server listening (if `WEBHOOK_API_KEY` is
set). Message your bot on Telegram — `/help` lists the available commands.

## Testing

```bash
npm test          # runs all *.test.ts files wired into package.json's test script
npm run lint       # ESLint over src/ — see caveat below
```

To run one file or filter by test name:

```bash
npx tsx --test src/expense/expense.test.ts
npx tsx --test --test-name-pattern="undoLastTransaction" src/expense/expense.test.ts
```

**New test files must be added explicitly** to the `test` script in
[package.json](package.json) — there's no glob discovery.

Caveats:
- **No test hits the real Gemini API by default.** Every Gemini call site used
  by the default test run is stubbed: [src/bot/ai.test.ts](src/bot/ai.test.ts)
  stubs `global.fetch` directly, and [src/expense/expense.test.ts](src/expense/expense.test.ts)
  / [src/webhook/webhook.test.ts](src/webhook/webhook.test.ts) stub it via the
  shared helper [src/testing/geminiStub.ts](src/testing/geminiStub.ts), which
  keyword-matches the merchant/note text in the categorization prompt to
  return a deterministic category — so `logExpense`'s AI categorization
  ([src/expense/categorizer.ts](src/expense/categorizer.ts)) never makes a
  network call in tests. The one exception is opt-in only (see below).
- Set `RUN_LIVE_AI_TESTS=1` to additionally run the one deliberately-skipped
  test in `ai.test.ts` that calls the real Gemini API — costs real quota, do
  this sparingly (the free tier is rate-limited, e.g. 20 requests/day).
- `./data/test-plutus.db` is deleted and recreated by
  [src/expense/expense.test.ts](src/expense/expense.test.ts) on each run —
  don't point `DATABASE_URL` at it.
- `npm run lint` currently reports real findings (mostly `@typescript-eslint/no-explicit-any`
  in test files, plus one unused import in `src/index.ts`) — it's not a config
  problem, just pre-existing lint debt. Don't be surprised if it exits non-zero
  on a clean checkout.

### Manual smoke test

1. `npm run dev`, confirm the bot responds to `/help` on Telegram.
2. `/today` and `/month` — should return empty/zero summaries on a fresh db.
3. Send a natural-language message like `Set food budget to $800/month`, then
   `/budget` — should show the new budget with 0% spent.
4. If testing the iOS Shortcuts webhook: `curl http://localhost:3000/api/health`
   should return `{"status":"ok"}`; full setup (including exposing it via
   Cloudflare Tunnel) is in [docs/setup/ios-shortcut-setup.md](docs/setup/ios-shortcut-setup.md).
5. `/undo` after logging something via the webhook or a slash command should
   remove the most recent transaction.

## Available Commands

| Command | Behavior |
|---|---|
| `/today` | Today's spending summary |
| `/month` | Monthly breakdown by category |
| `/budget` | Budget status per category (also settable via natural language, e.g. "set food budget to $800/month") |
| `/export` | Export transactions to CSV (`./data/exports/`) |
| `/undo` | Undo the single most recent transaction |
| `/digest` | Preview tonight's AI digest on demand |
| `/portfolio` | Placeholder — not implemented yet |
| `/help` | List commands |

Free text is also classified by Gemini into `expense \| query \| budget \|
correction \| recurring \| help \| unknown` — budget-setting and
transaction-correction messages are fully wired; a message classified as
"expense" currently gets acknowledged but not persisted (see [Status](#status)).

## Architecture notes

- **Two independent SQLite access paths.** [src/db/client.ts](src/db/client.ts)
  is a Drizzle-wrapped singleton used for the canonical schema
  ([src/db/schema.ts](src/db/schema.ts)). [src/expense/service.ts](src/expense/service.ts)
  opens its **own** raw `better-sqlite3` connection per call and runs
  hand-written SQL against the same file. They're kept in sync by hand — if
  you touch a column in `schema.ts`, update the raw SQL in `service.ts` too.
- All monetary amounts are stored as **integer cents**, never floats.
  `amount_sgd` is always the SGD-normalized value used for summaries/budgets,
  regardless of the transaction's original currency.
- Supported currencies: `SGD` (base), `MYR`, `USD`, `BTC`, `ETH`, `BETH` —
  hardcoded exchange rates in [src/config/currencies.ts](src/config/currencies.ts),
  not fetched live.
- `correctLastTransaction` only ever mutates the single most recent
  transaction — there's no way to target an arbitrary past one.

## Project Structure

```
plutus-ai/
├── src/
│   ├── index.ts                  # Entry point — wires up db, bot, schedulers, webhook
│   ├── config/                   # Env validation (Zod), currency table/rates
│   ├── types/                    # Shared domain types (transaction, portfolio, budget)
│   ├── db/                       # Drizzle schema/client + migrations
│   ├── bot/                      # Telegram bot: commands, handlers, middleware, Gemini classifier
│   ├── expense/                  # Expense engine — logging, categorization, currency resolution
│   ├── budget/                   # Budget CRUD, progress tracking, alerts
│   ├── digest/                   # Nightly AI-written spending digest + cron
│   ├── scheduler/                # Recurring-transaction cron
│   ├── webhook/                  # iOS Shortcuts Apple Pay webhook (Hono)
│   └── utils/                    # Logger, currency helpers
├── docs/
│   ├── setup/                    # ios-shortcut-setup.md
│   └── tasks/                    # Module-by-module build plan (01–07)
├── data/                          # SQLite db + CSV exports (gitignored)
└── .env.example
```

## Scripts

```bash
npm run dev          # run with tsx (hot reload, no build step)
npm run build         # tsc -> dist/
npm run start         # run compiled dist/index.js
npm run lint          # eslint src
npm run format        # prettier --write src/**/*.ts
npm test              # node's built-in test runner over the wired-up *.test.ts files
npm run db:generate   # drizzle-kit generate (new migration from schema changes)
npm run db:migrate    # apply migrations
npm run db:studio     # Drizzle Studio, browse the db
```

## Troubleshooting

- **Startup fails immediately with an environment validation error** — check
  `GOOGLE_API_KEY` is set in `.env`; it's the one required variable.
- **Bot doesn't respond on Telegram** — confirm `TELEGRAM_BOT_TOKEN` is set and
  the app logged "Telegram bot started successfully"; if
  `TELEGRAM_AUTHORIZED_CHAT_ID` is set, make sure you're messaging from that
  chat.
- **Gemini classification/categorization errors** — check quota/billing at
  [ai.dev/rate-limit](https://ai.dev/rate-limit); confirm the model id
  (`gemini-3.6-flash`, in [src/bot/ai.ts](src/bot/ai.ts) and
  [src/expense/categorizer.ts](src/expense/categorizer.ts)) is still valid via
  `GET /v1beta/models` against your key — Gemini model ids get deprecated.
- **Database looks wrong / want a clean slate** — delete `./data/pluto.db`
  (loses all local data) and restart; tables are recreated automatically.
- **iOS Shortcuts webhook unreachable** — see the troubleshooting section of
  [docs/setup/ios-shortcut-setup.md](docs/setup/ios-shortcut-setup.md).

## License

ISC — see [LICENSE](LICENSE).
