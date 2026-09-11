# Setting up Plutus AI

A start-to-finish guide: from a fresh clone to a bot running for free on
**Vercel + Turso**, plus how to run it locally for development.

Plutus AI is **multi-user with bring-your-own-key**. The server holds no
Gemini key of its own. Each person registers through the bot with `/setup`
and pastes their own API key, which is encrypted at rest. The first person to
register (the `ADMIN_CHAT_ID` chat) becomes the admin and is approved
automatically; everyone after that needs the admin to approve them.

See [docs/architecture.md](docs/architecture.md) for diagrams of how the
pieces fit together.

---

## How it runs

| | Production | Local development |
|---|---|---|
| Where | Vercel (free Hobby plan) | Your machine |
| Database | Turso (free), Tokyo | A SQLite file in `./data/` |
| Telegram | Telegram pushes updates to a webhook | The process polls Telegram |
| Daily jobs | Vercel Cron | Built-in scheduler |
| Command | `git push` | `npm run dev` |

**Use two Telegram bots**, one for production and one for development. A bot
token can only deliver its messages to one place at a time.

## 1. Prerequisites

- **Node.js 22 or newer.**
- **Accounts** (all free, no credit card needed): [GitHub](https://github.com)
  with this repo pushed to it, [Vercel](https://vercel.com/signup), and
  [Turso](https://turso.tech).
- **Two Telegram bots.** Message [@BotFather](https://t.me/BotFather), send
  `/newbot` twice, and keep both tokens, e.g. `plutus_bot` for production and
  `plutus_dev_bot` for development.
- **Your Telegram chat ID.** Message [@userinfobot](https://t.me/userinfobot);
  it replies with your numeric ID. This becomes `ADMIN_CHAT_ID`.
- **A Google Gemini API key**, free from
  [aistudio.google.com/apikey](https://aistudio.google.com/apikey). This does
  **not** go in any config; you paste it into the bot during `/setup`.

```bash
git clone https://github.com/zzkhong/plutus-ai.git
cd plutus-ai
npm install
```

## 2. Deploy to production (Vercel + Turso)

### 2.1 Create the Turso database

1. Sign in at [app.turso.tech](https://app.turso.tech) and create a database,
   e.g. `plutus`.
2. Choose the **AWS Tokyo (`aws-ap-northeast-1`)** location. Turso has no
   Singapore location. Tokyo is the closest, and step 2.3 runs Vercel there too
   so the two sit next to each other.
3. Copy the database URL. It looks like
   `libsql://plutus-<your-org>.aws-ap-northeast-1.turso.io`.
4. Create a token for the database with read and write access and no expiry.

Or with the [Turso CLI](https://docs.turso.tech/cli/introduction), once the
database exists:

```bash
turso db show plutus --url
turso db tokens create plutus
```

You don't create any tables yourself. The first deploy does that.

### 2.2 Generate three secrets

Run this three times and label the outputs:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Name | Used for |
|---|---|
| `ENCRYPTION_KEY` | Encrypting users' API keys in the database |
| `TELEGRAM_WEBHOOK_SECRET` | Proving webhook requests really come from Telegram |
| `CRON_SECRET` | Proving the daily-job requests really come from Vercel Cron |

> **Keep `ENCRYPTION_KEY` safe.** If it changes, every stored API key becomes
> unreadable and everyone has to run `/setup` again. Store all three in a
> password manager.

### 2.3 Create the Vercel project

1. In Vercel: **Add New → Project**, and import your `plutus-ai` GitHub repo.
2. Leave the framework and build settings as detected. Vercel recognises the
   Hono app in `src/app.ts`, and [`vercel.json`](vercel.json) supplies the
   build command, the Tokyo region (`hnd1`) and the two daily jobs.
3. Under **Environment Variables**, add these for the **Production**
   environment only:

| Variable | Value |
|---|---|
| `DATABASE_URL` | The Turso URL from 2.1 (`libsql://…`) |
| `DATABASE_AUTH_TOKEN` | The Turso token from 2.1 |
| `ENCRYPTION_KEY` | From 2.2 |
| `TELEGRAM_BOT_TOKEN` | Your **production** bot's token |
| `ADMIN_CHAT_ID` | Your chat ID |
| `TELEGRAM_WEBHOOK_SECRET` | From 2.2 |
| `CRON_SECRET` | From 2.2 |
| `APP_TIMEZONE` | Optional, defaults to `Asia/Singapore` |

Leave Preview unticked. Builds for other branches then skip database
migrations, so an unfinished branch can never change your production data.

4. Click **Deploy**. The build type-checks the code, then creates the tables
   in Turso. When it finishes, open **Project → Domains** and note the
   production domain, e.g. `plutus-ai.vercel.app`.

Check that it's up:

```bash
curl https://plutus-ai.vercel.app/api/health
# {"status":"ok"}
```

> Use the production domain, not a per-deployment URL like
> `plutus-ai-a1b2c3.vercel.app`. By default those sit behind Vercel's login,
> so Telegram would get a 401.

### 2.4 Point Telegram at the deployment

On your own machine, with your **production** bot token and the same webhook
secret you gave Vercel:

```bash
TELEGRAM_BOT_TOKEN=<production token> TELEGRAM_WEBHOOK_SECRET=<secret from 2.2> \
  npm run telegram:webhook -- set https://plutus-ai.vercel.app
```

(On Windows PowerShell, set those with `$env:TELEGRAM_BOT_TOKEN="…"` on the
lines before instead.)

You should see `Webhook set: https://plutus-ai.vercel.app/api/telegram`.
`npm run telegram:webhook -- info` shows the current registration and, if
deliveries are failing, Telegram's `last_error_message`.

### 2.5 Register yourself

In Telegram, open your **production** bot and:

1. Send **`/setup`**.
2. Reply **`gemini`**, the only provider supported today.
3. Paste your **Gemini API key**. The bot checks it against the live API, then
   deletes your message so the key doesn't stay in chat history.
4. Because you're `ADMIN_CHAT_ID`, you're approved automatically.

Then try it:

```
/help
Spent $4.50 at Ya Kun
/today
Set food budget to $500/month
/budget
```

That's it, you're live. From now on, deploying is just `git push` to `main`.

## 3. Local development

The standalone process runs everything on your machine against a SQLite file.
It uses your **development** bot, so it never touches production.

```bash
cp .env.example .env
```

Fill in `.env`:

```ini
ENCRYPTION_KEY=<any 64-hex value; a different one from production is fine>
DATABASE_URL=file:./data/pluto.db
TELEGRAM_BOT_TOKEN=<your DEVELOPMENT bot token>
ADMIN_CHAT_ID=<your chat ID>
APP_TIMEZONE=Asia/Singapore
```

Leave `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET` and `DATABASE_AUTH_TOKEN` empty;
they're only used on Vercel. Then:

```bash
npm run dev
```

The database file and tables are created on first run. You should see:

```
[INFO] Database ready
[INFO] Recurring transactions scheduler started (runs daily at 00:00 Asia/Singapore)
[INFO] Daily digest scheduler started (runs daily at 22:00 Asia/Singapore)
[INFO] HTTP server listening on port 3000
[INFO] Telegram bot started (long polling)
```

Message your development bot `/setup` as in step 2.5.

> **If it stops with "This bot token has a webhook registered"**, you've put
> the production token in `.env`. Starting would delete production's webhook
> and cut it off from Telegram, so it refuses. Use the development token.

Other commands:

```bash
npm test            # the whole test suite, no network needed
npm run typecheck
npm run lint
npm run build && npm start   # run the compiled standalone process
```

## 4. Adding other people

1. They message your production bot, run `/setup`, pick `gemini` and paste
   **their own** Gemini key.
2. You get *"New signup pending approval: chat_id 987654321."*
3. Reply **`/approve 987654321`** (or `/reject 987654321`). They're notified
   either way.

Until approved, a user can only use `/setup` and `/help`. Everyone's
transactions, budgets and holdings are private to them. Rejecting someone
deletes all of their data.

## 5. Apple Pay auto-logging (optional)

Each approved user has their own webhook key. Send **`/webhookkey`** to the
bot to get yours, then follow
[docs/setup/ios-shortcut-setup.md](docs/setup/ios-shortcut-setup.md). On
Vercel the Shortcut posts straight to
`https://plutus-ai.vercel.app/api/apple-pay`. There's no tunnel to run.

Test it without an iPhone:

```bash
curl -X POST https://plutus-ai.vercel.app/api/apple-pay \
  -H "Content-Type: application/json" \
  -H "x-api-key: <your /webhookkey value>" \
  -d '{"amount": "12.50", "merchant": "McDonalds", "card": "DBS"}'
```

## How the database works

Everything lives in one libSQL (SQLite-compatible) database: **Turso** in
production, a **local file** in development. Both use the same code and the
same migrations.

- **Tables are created and upgraded automatically.** Each deploy runs any new
  migrations from `src/db/migrations/` before the new code serves traffic, and
  the local process does the same on startup. Each migration runs once,
  all-or-nothing; a failed one rolls back and stops the deploy.
- **Deploying never wipes data.** Your data lives in Turso, completely
  separate from the code Vercel deploys.
- **All data is per user**, and API keys are encrypted with `ENCRYPTION_KEY`.
  The database and that key are a pair: back up both.

### Backups

Turso's free plan keeps one day of point-in-time restore. For anything longer,
take your own dump:

```bash
turso db shell plutus .dump > plutus-backup-$(date +%F).sql
```

### Starting fresh

- **Production:** in Turso, destroy the database and create a new one with the
  same name. Create a new token, update `DATABASE_AUTH_TOKEN` in Vercel, and
  redeploy. The redeploy recreates the tables. Everyone runs `/setup` again.
- **Local:** stop `npm run dev`, delete `data/pluto.db`, and start it again.

When you change `src/db/schema.ts`, run `npm run db:generate` and **read the
SQL it produces** before deploying. A new `NOT NULL` column needs a default or
it fails on a table that already has rows, and a rename can come out as
drop-and-recreate, which loses that column's data.

## Free-tier limits

- **Turso free:** 5 GB of storage, 500 million rows read and 10 million rows
  written per month. A personal bot uses a tiny fraction of that.
- **Vercel Hobby:** for personal, non-commercial use. Its scheduled jobs run
  once a day at some point within the scheduled hour, so the 22:00 digest
  arrives between 22:00 and 22:59.

## Command reference

| Command | What it does |
|---|---|
| `/setup` | Register, or rotate your LLM API key |
| `/today` / `/month` | Spending summary |
| `/budget` | Budget status per category |
| `/portfolio` | Net worth and allocation |
| `/split` | Split a bill from a receipt photo (`/cancel` aborts) |
| `/digest` | Preview tonight's digest |
| `/export` | Get this year's transactions as a CSV file |
| `/undo` | Undo your last transaction |
| `/webhookkey` | Show your iOS Shortcut webhook key |
| `/approve <chat_id>` / `/reject <chat_id>` | Admin only |
| `/help` | Command list |

You can also just talk to it: *"Spent $4.50 at Ya Kun"*, *"How much did I
spend on food?"*, *"Netflix $15.98 every 5th"*, *"I hold 0.5 BTC"*, or send a
voice note saying any of those.

## Troubleshooting

**The production bot doesn't reply.**
Run `npm run telegram:webhook -- info` with the production token. Then:

- If `url` is empty, redo step 2.4.
- A `last_error_message` like `Wrong response from the webhook: 401` means
  `TELEGRAM_WEBHOOK_SECRET` differs between Vercel and the value you registered.
  Make them match and run `set` again.
- A `503` means `TELEGRAM_WEBHOOK_SECRET` or `TELEGRAM_BOT_TOKEN` isn't set in
  Vercel. Add it, then redeploy, because environment changes only apply to new
  deployments.

**The Vercel build fails with `Invalid environment configuration`.**
A required variable is missing or malformed for Production. The build log names
it: usually `ENCRYPTION_KEY` (must be 64 hex characters) or
`DATABASE_AUTH_TOKEN` (required for a `libsql://` URL).

**No nightly digest.**
Check Vercel's **Cron Jobs** tab. A `503` there means `CRON_SECRET` isn't set.
On Hobby the digest can arrive any time between 22:00 and 22:59.

**"Run /setup to get started" to everything.**
That chat isn't registered yet. If you expected to be admin, check that
`ADMIN_CHAT_ID` exactly matches the ID @userinfobot gave you.

**"Still waiting on admin approval".**
The admin needs to `/approve <your chat_id>`.

**"That key didn't work — the provider rejected it".**
Check the key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
The free tier is rate-limited, so a heavily used key can fail validation.

**Local: `table budgets already exists` on startup.**
`data/pluto.db` was created by an older version of the app. Delete it.

**Gemini classification suddenly failing for everyone.**
The model id is pinned in [src/llm/gemini.ts](src/llm/gemini.ts), and Gemini
model ids get deprecated. Check `GET /v1beta/models` against a working key.

## Where to go next

- [docs/architecture.md](docs/architecture.md) — diagrams and design decisions
- [README.md](README.md) — feature overview
- [CLAUDE.md](CLAUDE.md) — notes for working on the code
