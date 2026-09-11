# Plutus AI

A personal finance assistant that lives in Telegram. It logs expenses, tracks
budgets and a brokerage/crypto/cash portfolio, splits bills from a receipt
photo, sends a nightly AI-written digest with a market take on your holdings,
and can auto-log Apple Pay transactions from an iOS Shortcut.

It is **multi-user with bring-your-own-key**: each person registers through
the bot with `/setup` and supplies their own Gemini API key, stored encrypted
at rest. The first chat (`ADMIN_CHAT_ID`) bootstraps as admin and approves
everyone else. All data — transactions, budgets, holdings — is scoped per
user.

It runs **for free on Vercel + Turso**, or as one long-running Node process
for local development. See [docs/architecture.md](docs/architecture.md) for
diagrams.

Message understanding is **Gemini-first with no rule-based fallback** — if
Gemini can't classify a message, the bot says so rather than guessing with
keyword matching. Every classified intent is wired to a real action, and
voice notes are transcribed by Gemini and routed the same way typed text
is — see [Free-text intents](#free-text-intents-what-actually-happens)
below for the full list.

## Features

- **Expense logging** — free-text or voice messages ("Spent $4.50 at Ya
  Kun"), recurring charges, Apple Pay auto-logging via webhook, and the
  `/today`/`/month`/`/undo` commands. Currency is resolved per message
  (explicit currency > card mapping > merchant/note regex > SGD default) and
  every amount is normalized to SGD cents for reporting. `/export` sends the
  year's transactions as a CSV file.
- **Budgets** — set a per-category monthly limit in chat ("Set food budget
  to $500/month"); `/budget` shows spend-vs-limit with days left in the
  month, and the bot pings you the first time you cross a threshold.
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
  holdings, and a hold/trim/rebalance lean), sent every night around 10pm
  Singapore time (also available on demand via `/digest`).
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

- Node.js 22+
- Two [Telegram bot tokens](https://core.telegram.org/bots#how-do-i-create-a-bot)
  — one for production, one for local development
- A [Google Gemini API key](https://aistudio.google.com/apikey) per user —
  pasted into the bot during `/setup`, **not** put in any config
- For production: free [Vercel](https://vercel.com) (Hobby) and
  [Turso](https://turso.tech) accounts

## Setup

**→ [SETUP.md](SETUP.md) is the full walkthrough.** In short:

**Production** — create a Turso database in Tokyo, import the repo into
Vercel, set the environment variables, deploy, then point Telegram at it:

```bash
npm run telegram:webhook -- set https://<your-project>.vercel.app
```

**Local development** — with a separate development bot:

```bash
git clone https://github.com/zzkhong/plutus-ai.git
cd plutus-ai
npm install
cp .env.example .env   # set ENCRYPTION_KEY, your dev TELEGRAM_BOT_TOKEN and ADMIN_CHAT_ID
npm run dev
```

Then message the bot `/setup`, reply `gemini`, and paste your Gemini API key.
As `ADMIN_CHAT_ID` you are approved automatically.

## Running

| | Local / self-hosted | Vercel |
|---|---|---|
| Entrypoint | `src/standalone.ts` | `src/app.ts` |
| Telegram | long polling | webhook, `POST /api/telegram` |
| Daily jobs | node-cron | Vercel Cron → `/api/cron/*` |
| Database | SQLite file (`file:./data/pluto.db`) | Turso (`libsql://…`) |
| Migrations | on startup | during `npm run vercel-build` |

```bash
npm run dev      # standalone process with hot reload (tsx)
npm run build    # compile to dist/ and copy migrations
npm run start    # run the compiled standalone process
```

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
is the Apple Pay webhook. Get your personal key from the bot with
`/webhookkey`:

```bash
curl -X POST https://<your-project>.vercel.app/api/apple-pay \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your /webhookkey value>" \
  -d '{"amount": "12.50", "merchant": "McDonalds", "card": "DBS"}'
```

Locally, use `http://localhost:3000/api/apple-pay`. This logs a real
transaction against your account (category inferred by Gemini) — `/today`
will then show it, and you get a Telegram confirmation.

### iOS Shortcuts (Apple Pay auto-logging)

Optional. See [docs/setup/ios-shortcut-setup.md](docs/setup/ios-shortcut-setup.md)
for wiring up a Shortcuts automation so Apple Pay purchases log themselves.

## Automated tests

```bash
npm test           # runs the full fixed test list via node's test runner
npm run typecheck  # tsc --noEmit over src, tests included
npm run lint       # eslint
```

Run a single file or filter by name:

```bash
npx tsx --test src/expense/expense.test.ts
npx tsx --test --test-name-pattern="undoLastTransaction" src/expense/expense.test.ts
```

No test hits the network by default — every Gemini call is stubbed, and each
test file uses its own SQLite file in `./data/`. `npm test` runs a **fixed
list** of test files wired into `package.json`'s `test` script, not a glob —
a new `*.test.ts` file must be added there explicitly or it won't run. See
[CLAUDE.md](CLAUDE.md#commands) for the conventions to follow.

## Troubleshooting

- **The production bot doesn't reply** — run `npm run telegram:webhook -- info`
  with the production token and read `last_error_message`. See
  [SETUP.md](SETUP.md#troubleshooting).
- **Local `npm run dev` refuses to start polling** — you're using the
  production bot's token, which is claimed by its webhook. Use a separate
  development bot.
- **Startup throws `Invalid environment configuration`** — the log names the
  field; usually `ENCRYPTION_KEY` (64 hex characters), `ADMIN_CHAT_ID`
  (required with `TELEGRAM_BOT_TOKEN`), or `DATABASE_AUTH_TOKEN` (required for
  a Turso URL).
- **Gemini classification errors** — the model id is pinned in
  [src/llm/gemini.ts](src/llm/gemini.ts); if it starts failing outright,
  check `GET /v1beta/models` against your key for deprecation.

## Project layout

See [docs/architecture.md](docs/architecture.md) for diagrams,
[CLAUDE.md](CLAUDE.md) for architecture notes, and [docs/tasks/](docs/tasks/)
for the build plan this project was implemented against.

## License

ISC
