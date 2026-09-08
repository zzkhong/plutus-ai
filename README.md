# Plutus AI

A personal finance assistant that lives in Telegram. It tracks a budget, a
brokerage/crypto/cash portfolio, splits bills from a receipt photo, sends a
nightly AI-written digest, and can auto-log Apple Pay transactions from an
iOS Shortcut.

Message understanding is **Gemini-first with no rule-based fallback** — if
Gemini can't classify a message, the bot says so rather than guessing with
keyword matching. Every classified intent is wired to a real action, and
voice notes are transcribed by Gemini and routed the same way typed text
is — see [Free-text intents](#free-text-intents-what-actually-happens)
below for the full list.

## Features

- **Expense logging** — via the `/today`/`/month`/`/export`/`/undo` slash
  commands, free-text or voice messages ("Spent $4.50 at Ya Kun"), the
  recurring-transaction cron, and Apple Pay auto-logging via webhook.
  Currency is resolved per-message (explicit currency > card mapping >
  merchant/note regex > SGD default) and every amount is normalized to SGD
  cents for reporting.
- **Budgets** — set a per-category monthly limit in chat ("Set food budget
  to $500/month"); `/budget` shows spend-vs-limit with days left in the
  month, and the bot proactively pings you the first time you cross a
  threshold.
- **Portfolio tracker** — `/portfolio` for net worth and allocation across
  brokerage (upload an IBKR/Moomoo statement PDF), crypto, and cash (add
  crypto/cash holdings in chat, e.g. "I hold 0.5 BTC"). Prices come from
  Yahoo Finance and CoinGecko.
- **Bill splitting** — `/split`, send a receipt photo, then say "split
  evenly among 3" or "Alice had the burger, I had the salad" — the bot
  extracts line items, computes each person's share (tax/tip applied
  proportionally), and can log your own share as an expense.
- **Daily digest** — an AI-written summary of the day's spending, sent
  every night at 10pm Asia/Singapore (also available on demand via
  `/digest`).
- **Corrections** — "actually that was $12 not $10" retroactively edits
  your most recent transaction.

### Free-text intents: what actually happens

Every message is classified by Gemini into an intent, and every intent is
wired to a real action:

| You say something like... | What happens |
|---|---|
| "Spent $4.50 at Ya Kun" | **Real** — logs an expense (category inferred by Gemini) |
| "How much did I spend on food?" | **Real** — pulls real spending data for the mentioned period (today/week/month) |
| "Set food budget to $500/month" | **Real** — updates your budget |
| "Actually that was $12 not $10" | **Real** — corrects your last transaction |
| "I hold 0.5 BTC" | **Real** — adds/updates a portfolio holding |
| "Netflix $15.98 every 5th" | **Real** — sets up a recurring monthly charge |
| "Cancel my Spotify subscription" | **Real** — removes a recurring charge matched by merchant name |
| A voice note saying any of the above | **Real** — Gemini transcribes it, then it's routed exactly like typed text (replies are prefixed `Heard: "..."` so you can see what was understood) |

See [CLAUDE.md](CLAUDE.md#request-flow-telegram) for the code-level
breakdown if you're picking up work here.

## Requirements

- Node.js 20+ (better-sqlite3 needs a version with prebuilt native bindings
  for your platform — see [Troubleshooting](#troubleshooting) if `npm
  install` tries to compile from source)
- A [Telegram bot token](https://core.telegram.org/bots#how-do-i-create-a-bot)
  (optional — everything except the Telegram bot itself, i.e. the webhook
  and schedulers, still runs without one)
- A [Google Gemini API key](https://aistudio.google.com/apikey) — **required**,
  there's no fallback classifier

## Setup

```bash
git clone https://github.com/zzkhong/plutus-ai.git
cd plutus-ai
npm install
cp .env.example .env
```

Edit `.env`:

| Variable | Required | Notes |
|---|---|---|
| `GOOGLE_API_KEY` | **Yes** | Startup fails without it — every message classification goes through Gemini. |
| `TELEGRAM_BOT_TOKEN` | No | Without it the bot process still runs (schedulers + webhook), but no Telegram bot starts. |
| `TELEGRAM_AUTHORIZED_CHAT_ID` | No | Locks the bot to a single chat. Leave unset during setup to discover your chat ID (see below), then set it. |
| `DATABASE_URL` | No | Defaults to `./data/pluto.db`, created automatically on first run. |
| `TZ` | Recommended | Set to `Asia/Singapore` so "today" boundaries and the 10pm digest line up correctly. |
| `WEBHOOK_API_KEY` | No | Only needed for the iOS Shortcuts Apple Pay integration — see [docs/setup/ios-shortcut-setup.md](docs/setup/ios-shortcut-setup.md). The webhook server doesn't start without it. |
| `PORT` | No | Webhook server port, defaults to `3000`. |

To get a Telegram bot token: message [@BotFather](https://t.me/BotFather),
`/newbot`, follow the prompts. To find your chat ID: start a chat with your
new bot, send it any message, then check the app logs on startup (or query
`https://api.telegram.org/bot<TOKEN>/getUpdates`) for `chat.id`.

## Running

```bash
npm run dev      # hot-reload dev server (tsx)
```

On a clean run this creates `./data/pluto.db` and all tables automatically
— no separate migration step is needed to get started. You should see log
lines confirming the database, Telegram bot (if configured), recurring
scheduler, digest scheduler, and webhook server all coming up.

For production:

```bash
npm run build     # tsc -> dist/
npm run start     # node dist/index.js
```

Drizzle migration commands (`db:generate`, `db:migrate`, `db:studio`) exist
for schema changes under `src/db/schema.ts` — see
[CLAUDE.md](CLAUDE.md#two-independent-sqlite-access-paths--read-before-touching-persistence)
for why the expense module doesn't go through them.

### Try it

In your Telegram chat with the bot:

```
/help
Set food budget to $500/month
/budget
I hold 0.5 BTC
/portfolio
Spent $4.50 at Ya Kun
/today
/split
```

### Testing expense logging directly

Without Telegram, the most direct way to exercise `logExpense` end-to-end
is the webhook (set `WEBHOOK_API_KEY` in `.env` first):

```bash
curl -X POST http://localhost:3000/api/apple-pay \
  -H "Content-Type: application/json" \
  -H "x-api-key: $WEBHOOK_API_KEY" \
  -d '{"amount": "12.50", "merchant": "McDonald'"'"'s", "card": "DBS"}'
```

This logs a real transaction (category inferred by Gemini) — `/today` in
Telegram will then show it, and it'll send a Telegram confirmation if
`TELEGRAM_AUTHORIZED_CHAT_ID` is set.

### iOS Shortcuts (Apple Pay auto-logging)

Optional. See [docs/setup/ios-shortcut-setup.md](docs/setup/ios-shortcut-setup.md)
for wiring up a Shortcuts automation + Cloudflare Tunnel so Apple Pay
purchases log themselves.

## Automated tests

```bash
npm test          # runs the full fixed test list via node's test runner
npm run lint       # eslint (currently reports pre-existing lint debt, mostly `any` in tests)
```

Run a single file or filter by name:

```bash
npx tsx --test src/expense/expense.test.ts
npx tsx --test --test-name-pattern="undoLastTransaction" src/expense/expense.test.ts
```

No test hits the real Gemini API by default — every Gemini call site is
stubbed. `npm test` runs a **fixed list** of test files wired into
`package.json`'s `test` script, not a glob — a new `*.test.ts` file must be
added there explicitly or it won't run. See
[CLAUDE.md](CLAUDE.md#commands) for the current list and the stubbing
pattern to follow for new tests.

## Troubleshooting

- **`npm install` fails compiling `better-sqlite3`** — you likely need
  build tools for native modules (Windows: `npm install -g windows-build-tools`
  or Visual Studio Build Tools with the C++ workload; macOS: Xcode Command
  Line Tools; Linux: `build-essential` + `python3`). Prebuilt binaries cover
  most common Node versions/platforms, so this usually only bites on an
  unusual combination.
- **Startup throws `Invalid environment configuration`** — `GOOGLE_API_KEY`
  is missing or empty in `.env`; check `src/config/env.ts` for the full
  validated schema.
- **Bot doesn't respond in Telegram** — confirm `TELEGRAM_BOT_TOKEN` is set
  and, if `TELEGRAM_AUTHORIZED_CHAT_ID` is set, that you're messaging from
  that exact chat.
- **Gemini classification errors** — the model id is pinned in
  [src/bot/ai.ts](src/bot/ai.ts); if it starts failing outright, check
  `GET /v1beta/models` against your key for deprecation.

## Project layout

See [CLAUDE.md](CLAUDE.md) for full architecture notes (request flow, the
two SQLite access paths, module-by-module breakdown) and
[docs/tasks/](docs/tasks/) for the module-by-module build plan this project
was implemented against.

## License

ISC
