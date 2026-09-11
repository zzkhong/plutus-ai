# Setting up Plutus AI

A start-to-finish guide: from a fresh clone to logging your first expense
in Telegram.

Plutus AI is **multi-user with bring-your-own-key**. The server holds no
Gemini key of its own — each person registers through the bot with `/setup`
and pastes their own API key, which is encrypted at rest. The first person
to register (the `ADMIN_CHAT_ID` chat) becomes the admin and is approved
automatically; everyone after that needs the admin to approve them.

---

## 1. Prerequisites

- **Node.js 20 or newer.** `better-sqlite3` ships prebuilt binaries for
  common Node/OS combinations; if `npm install` tries to compile from
  source, see [Troubleshooting](#troubleshooting).
- **A Telegram bot token** — optional, but the bot is the only interface,
  so you want one. Message [@BotFather](https://t.me/BotFather), send
  `/newbot`, and follow the prompts.
- **A Google Gemini API key** — get one free at
  [aistudio.google.com/apikey](https://aistudio.google.com/apikey). You do
  **not** put this in `.env`; you hand it to the bot during `/setup`.

## 2. Install

```bash
git clone https://github.com/zzkhong/plutus-ai.git
cd plutus-ai
npm install
cp .env.example .env
```

## 3. Configure `.env`

| Variable | Required | What it does |
|---|---|---|
| `ENCRYPTION_KEY` | **Yes** | 64 hex chars (32 bytes). Encrypts each user's stored API key with AES-256-GCM. Startup fails without it. |
| `ADMIN_CHAT_ID` | **Yes, if `TELEGRAM_BOT_TOKEN` is set** | The Telegram chat that bootstraps as admin. Without it nobody — including you — could ever be approved, so startup refuses. |
| `TELEGRAM_BOT_TOKEN` | No | Without it the bot doesn't start, but the webhook server and the schedulers still run. |
| `DATABASE_URL` | No | Defaults to `./data/pluto.db`, created on first run. |
| `TZ` | Recommended | Set `Asia/Singapore` so "today" boundaries and the 10pm digest line up. |
| `PORT` | No | Webhook server port, defaults to `3000`. |
| `LOG_LEVEL` | No | `debug` \| `info` \| `warn` \| `error`, defaults to `info`. |

### Generate your `ENCRYPTION_KEY`

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the output into `.env` as `ENCRYPTION_KEY=...`.

> **Keep this key.** Changing it makes every stored API key undecryptable
> and every user has to re-run `/setup`. Back it up alongside your database.

### Find your `ADMIN_CHAT_ID`

Message [@userinfobot](https://t.me/userinfobot) on Telegram — it replies
with your numeric ID. Alternatively, start a chat with your own bot, send
it any message, and read `chat.id` from
`https://api.telegram.org/bot<TOKEN>/getUpdates`.

A filled-in `.env` looks like:

```ini
NODE_ENV=development
TZ=Asia/Singapore
DATABASE_URL=./data/pluto.db
TELEGRAM_BOT_TOKEN=8123456789:AAH...your-token...
ADMIN_CHAT_ID=123456789
ENCRYPTION_KEY=3f8a...64-hex-chars...b1c2
LOG_LEVEL=info
PORT=3000
```

> **Upgrading from an older checkout?** `GOOGLE_API_KEY`,
> `WEBHOOK_API_KEY`, and `TELEGRAM_AUTHORIZED_CHAT_ID` are no longer used
> and are ignored if present — keys are per-user now. Delete them and add
> `ADMIN_CHAT_ID`.

## 4. Run it

```bash
npm run dev
```

The database and all tables are created automatically on first run — no
separate migration step. You should see:

```
[INFO] Database initialized successfully
[INFO] Telegram bot core initialized
[INFO] Recurring transactions scheduler started (runs daily at 00:00)
[INFO] Daily digest scheduler started (runs daily at 22:00 Asia/Singapore)
[INFO] Webhook server listening on port 3000
```

For production:

```bash
npm run build     # tsc -> dist/, and copies db migrations into dist/
npm run start     # node dist/index.js
```

## 5. Register yourself in the bot

Open Telegram, find your bot, and:

1. Send **`/setup`**.
2. The bot asks which provider — reply **`gemini`** (the only one supported
   today).
3. Paste your **Gemini API key**. The bot validates it against the live API,
   then deletes your message so the key doesn't sit in chat history.
4. Because you're messaging from `ADMIN_CHAT_ID`, you're auto-approved:
   *"You're auto-approved as the admin."*

Now try it:

```
/help
Spent $4.50 at Ya Kun
/today
Set food budget to $500/month
/budget
```

If the key is ever rejected or you want to rotate it, just run `/setup`
again — an already-approved user keeps their approval.

## 6. Adding other people (optional)

1. They message your bot and run `/setup`, picking `gemini` and pasting
   **their own** API key.
2. They land in `pending_approval`, and you (the admin) get a message:
   *"New signup pending approval: chat_id 987654321."*
3. You reply **`/approve 987654321`** (or `/reject 987654321`). They're
   notified either way.

Until approved, a user can only reach `/setup` and `/help`. Every user's
transactions, budgets, and holdings are scoped to them — nobody can see,
undo, or export anyone else's data.

## 7. Apple Pay auto-logging (optional)

Each approved user has their **own** webhook key — there is no shared
secret. Get yours from the bot with **`/webhookkey`**, then follow
[docs/setup/ios-shortcut-setup.md](docs/setup/ios-shortcut-setup.md) to
wire up the Shortcuts automation and a Cloudflare Tunnel.

You can sanity-check the endpoint without an iPhone:

```bash
curl -X POST http://localhost:3000/api/apple-pay \
  -H "Content-Type: application/json" \
  -H "x-api-key: <the key /webhookkey gave you>" \
  -d '{"amount": "12.50", "merchant": "McDonalds", "card": "DBS"}'
```

That logs a real transaction against your account and sends you a Telegram
confirmation — `/today` will show it.

## Command reference

| Command | What it does |
|---|---|
| `/setup` | Register, or rotate your LLM API key |
| `/today` / `/month` | Spending summary |
| `/budget` | Budget status per category |
| `/portfolio` | Net worth and allocation |
| `/split` | Split a bill from a receipt photo (`/cancel` aborts) |
| `/digest` | Preview tonight's digest |
| `/export` | Export your transactions to CSV |
| `/undo` | Undo your last transaction |
| `/webhookkey` | Show your iOS Shortcut webhook key |
| `/approve <chat_id>` / `/reject <chat_id>` | Admin only |
| `/help` | Command list |

You can also just talk to it: *"Spent $4.50 at Ya Kun"*, *"How much did I
spend on food?"*, *"Netflix $15.98 every 5th"*, *"I hold 0.5 BTC"*, or send
a voice note saying any of those.

## Troubleshooting

**`Invalid environment configuration` on startup**
`ENCRYPTION_KEY` is missing or isn't 64 hex characters, or you set
`TELEGRAM_BOT_TOKEN` without `ADMIN_CHAT_ID`. The error output names the
offending field.

**The bot replies "Run /setup to get started" to everything**
Your chat has no user row yet. Run `/setup`. If you expected to be the
admin, check `ADMIN_CHAT_ID` matches your actual chat ID exactly.

**"Still waiting on admin approval"**
You completed `/setup` but aren't approved. The admin needs to
`/approve <your chat_id>`. If *you* are meant to be the admin, your
`ADMIN_CHAT_ID` didn't match when you ran `/setup` — fix `.env`, restart,
and run `/setup` again.

**"That key didn't work — the provider rejected it"**
The Gemini API rejected the key. Check it at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey), and note
the free tier is rate-limited (roughly 20 requests/day), so a heavily used
key can fail validation.

**401 from the webhook**
The `x-api-key` header doesn't match any user's key. Re-check with
`/webhookkey`.

**403 from the webhook**
The key is real but that account isn't approved yet.

**`npm install` fails compiling `better-sqlite3`**
You need native build tools — Windows: Visual Studio Build Tools with the
C++ workload; macOS: Xcode Command Line Tools; Linux: `build-essential`
and `python3`.

**Gemini classification suddenly failing for everyone**
The model id is pinned in [src/llm/gemini.ts](src/llm/gemini.ts). Gemini
model ids get deprecated; check `GET /v1beta/models` against a working key.

## Where to go next

- [README.md](README.md) — feature overview
- [CLAUDE.md](CLAUDE.md) — architecture notes for working on the code
- [docs/tasks/](docs/tasks/) — the module-by-module build plan
