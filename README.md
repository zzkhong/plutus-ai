# Plutus AI

A personal finance assistant that lives in Telegram. It tracks a budget, a
brokerage/crypto/cash portfolio, splits bills from a receipt photo, sends a
nightly AI-written digest, and can auto-log Apple Pay transactions from an
iOS Shortcut.

It is **multi-user with bring-your-own-key**: each person registers through
the bot with `/setup` and supplies their own Gemini API key, stored
encrypted at rest. The first chat (`ADMIN_CHAT_ID`) bootstraps as admin and
approves everyone else. All data — transactions, budgets, holdings — is
scoped per user.

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
- **Daily digest** — an AI-written summary of the day's spending plus a
  market take on your portfolio (what today's news means for your actual
  holdings, and a hold/trim/rebalance lean), sent every night at 10pm
  Asia/Singapore (also available on demand via `/digest`).
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
- A [Google Gemini API key](https://aistudio.google.com/apikey) per user —
  supplied to the bot during `/setup`, **not** via `.env`

## Setup

**→ [SETUP.md](SETUP.md) is the full walkthrough**, from clone to your
first logged expense. The short version:

```bash
git clone https://github.com/zzkhong/plutus-ai.git
cd plutus-ai
npm install
cp .env.example .env
# generate an ENCRYPTION_KEY, set ADMIN_CHAT_ID and TELEGRAM_BOT_TOKEN
npm run dev
```

Then message your bot `/setup`, reply `gemini`, and paste your Gemini API
key. As `ADMIN_CHAT_ID` you are approved automatically.

Only two things are required in `.env`: `ENCRYPTION_KEY` (always) and
`ADMIN_CHAT_ID` (whenever `TELEGRAM_BOT_TOKEN` is set). There is no global
LLM key and no shared webhook secret — both are per-user. See
[SETUP.md](SETUP.md#3-configure-env) for the full table.

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
npm run build     # tsc -> dist/ (and copies db migrations into dist/)
npm run start     # node dist/index.js
```

Drizzle migration commands (`db:generate`, `db:migrate`, `db:studio`) exist
for schema changes under `src/db/schema.ts`; every module goes through
Drizzle — see [CLAUDE.md](CLAUDE.md#persistence).

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
is the webhook. Get your personal key from the bot with `/webhookkey`:

```bash
curl -X POST http://localhost:3000/api/apple-pay \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your /webhookkey value>" \
  -d '{"amount": "12.50", "merchant": "McDonald'"'"'s", "card": "DBS"}'
```

This logs a real transaction against your account (category inferred by
Gemini) — `/today` in Telegram will then show it, and you get a Telegram
confirmation if the bot is running.

### iOS Shortcuts (Apple Pay auto-logging)

Optional. See [docs/setup/ios-shortcut-setup.md](docs/setup/ios-shortcut-setup.md)
for wiring up a Shortcuts automation + Cloudflare Tunnel so Apple Pay
purchases log themselves.

## Automated tests

```bash
npm test           # runs the full fixed test list via node's test runner
npm run typecheck  # tsc --noEmit over src, tests included
npm run lint       # eslint — clean
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
- **Startup throws `Invalid environment configuration`** — `ENCRYPTION_KEY`
  is missing or not 64 hex characters, or `TELEGRAM_BOT_TOKEN` is set
  without `ADMIN_CHAT_ID`; check `src/config/env.ts` for the full validated
  schema.
- **Bot replies "Run /setup to get started"** — that chat has no user row
  yet. See [SETUP.md](SETUP.md#5-register-yourself-in-the-bot).
- **Gemini classification errors** — the model id is pinned in
  [src/llm/gemini.ts](src/llm/gemini.ts); if it starts failing outright,
  check `GET /v1beta/models` against your key for deprecation.

More in [SETUP.md](SETUP.md#troubleshooting).

## Project layout

See [CLAUDE.md](CLAUDE.md) for full architecture notes (request flow,
persistence, module-by-module breakdown) and [docs/tasks/](docs/tasks/) for
the build plan this project was implemented against.

## License

ISC
