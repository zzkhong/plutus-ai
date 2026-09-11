# Architecture

Plutus AI is one TypeScript codebase that runs in two ways:

| | **Production — Vercel + Turso** | **Local / self-hosted — standalone process** |
|---|---|---|
| Entrypoint | [`src/app.ts`](../src/app.ts), default-exports the Hono app | [`src/standalone.ts`](../src/standalone.ts), one long-running Node process |
| Telegram updates | Telegram **pushes** them to `POST /api/telegram` (webhook) | The process **long-polls** Telegram |
| Daily jobs | **Vercel Cron** calls `GET /api/cron/recurring` and `/api/cron/digest` | **node-cron** inside the process |
| Database | **Turso** (hosted libSQL), Tokyo | A local SQLite **file** (`file:./data/pluto.db`) |
| Migrations | During the Vercel build (`npm run vercel-build`) | On process startup |
| Apple Pay URL | `https://<project>.vercel.app/api/apple-pay` | `http://localhost:3000/api/apple-pay` (tunnel it to reach it from a phone) |

Both modes share every handler, service and query. The only differences are how
updates arrive and what triggers the daily jobs.

## Production: Vercel + Turso

```mermaid
flowchart LR
    subgraph users["People"]
        tg["Telegram app"]
        ios["iPhone Shortcut<br/>(Apple Pay automation)"]
    end

    tgapi["Telegram Bot API"]

    subgraph vercel["Vercel Hobby, region hnd1 (Tokyo)"]
        direction TB
        cron["Vercel Cron<br/>14:00 and 16:00 UTC daily"]
        rtg["POST /api/telegram"]
        rap["POST /api/apple-pay"]
        rcron["GET /api/cron/recurring<br/>GET /api/cron/digest"]
        app["Hono app (src/app.ts)<br/>one Vercel Function"]
        rtg --> app
        rap --> app
        rcron --> app
        cron --> rcron
    end

    turso[("Turso libSQL<br/>aws-ap-northeast-1 (Tokyo)")]
    gemini["Google Gemini API<br/>each user's own key"]
    prices["Yahoo Finance and CoinGecko"]

    tg -- "text, voice, photos, PDFs" --> tgapi
    tgapi -- "webhook + secret header" --> rtg
    ios -- "HTTPS + the user's x-api-key" --> rap
    app -- "replies and file downloads" --> tgapi
    app -- "SQL over HTTPS" --> turso
    app -- "classify, categorize, transcribe, advise" --> gemini
    app -- "price quotes" --> prices
```

Vercel and Turso sit in the same region (Tokyo). Turso has no Singapore
location, and a request makes several database round trips (auth lookup,
query, insert), so keeping the function next to the database matters more than
keeping it next to you. Telegram's servers, not your phone, call the webhook.

## Local development: the standalone process

```mermaid
flowchart LR
    tg["Telegram app<br/>(your dev bot)"] --> tgapi["Telegram Bot API"]
    subgraph proc["npm run dev (src/standalone.ts)"]
        direction TB
        poll["grammy long polling"]
        crons["node-cron<br/>00:00 recurring, 22:00 digest"]
        http["HTTP server :3000<br/>/api/apple-pay, /api/health"]
    end
    poll -- "getUpdates" --> tgapi
    proc --> file[("SQLite file<br/>./data/pluto.db")]
    proc --> gemini["Google Gemini API"]
```

Use a **separate bot token** locally. grammy's long polling deletes any
registered webhook when it starts, which would silently cut the production bot
off from Telegram. `startPolling()` refuses to start while a webhook is set.

## A message, end to end

```mermaid
sequenceDiagram
    autonumber
    actor U as You (Telegram)
    participant T as Telegram Bot API
    participant F as Vercel Function
    participant DB as Turso
    participant G as Gemini (your key)

    U->>T: "Spent $4.50 at Ya Kun"
    T->>F: POST /api/telegram with secret header
    F->>F: Check secret, bot.init() once per instance
    F-->>T: 200 OK, acknowledged immediately
    Note over F: The rest runs in waitUntil, so a slow Gemini call<br/>can't make Telegram time out and redeliver
    F->>DB: authMiddleware, find user by chat_id
    F->>G: classifyUserMessage, intent = expense
    F->>G: inferCategory, category = Food
    F->>DB: Insert transaction (integer SGD cents)
    F->>T: sendMessage("Logged S$4.50 ...")
    T->>U: Reply
```

## The nightly digest

```mermaid
sequenceDiagram
    participant C as Vercel Cron
    participant F as Vercel Function
    participant DB as Turso
    participant P as Yahoo / CoinGecko
    participant G as Gemini (each user's key)
    participant T as Telegram Bot API

    C->>F: GET /api/cron/digest (Bearer CRON_SECRET)
    F->>DB: listApproved()
    loop Each approved user, failures isolated per user
        F->>DB: Today's spending, budgets, recurring charges, holdings
        F->>P: Current prices
        F->>G: Summary line and grounded portfolio market take
        F->>T: sendMessage(that user's chat)
    end
    F-->>C: 200
```

## Code map

```mermaid
flowchart TB
    subgraph entry["Entrypoints"]
        appts["src/app.ts<br/>Vercel"]
        stand["src/standalone.ts<br/>long-running process"]
    end

    subgraph http["src/webhook: HTTP app"]
        rtel["routes/telegram.ts"]
        rapp["routes/apple-pay.ts + auth.ts"]
        rcr["routes/cron.ts"]
    end

    subgraph botmod["src/bot: Telegram"]
        mw["middleware/auth.ts<br/>chat_id to users row"]
        cmds["commands/*"]
        hnd["handlers: text, voice, document"]
    end

    subgraph domain["Domain services, all scoped by userId"]
        exp["expense"]
        bud["budget"]
        port["portfolio"]
        spl["split"]
        dig["digest"]
        usr["users"]
        sch["scheduler/recurring"]
    end

    llm["src/llm<br/>provider.ts to gemini.ts"]
    db["src/db<br/>Drizzle + libSQL"]

    appts --> http
    stand --> http
    stand --> botmod
    stand --> sch
    rtel --> botmod
    rcr --> sch
    rcr --> dig
    rapp --> exp
    botmod --> domain
    domain --> llm
    domain --> db
    llm --> usr
```

## Data model

```mermaid
erDiagram
    users ||--o{ transactions : owns
    users ||--o{ budgets : owns
    users ||--o{ budget_alerts : owns
    users ||--o{ holdings : owns
    users ||--o{ recurring_transactions : owns
    budgets ||--o{ budget_alerts : "fires at 80 and 100 percent"
    recurring_transactions ||--o{ transactions : "logs, via recurring_id"

    users {
        text id PK
        text telegram_chat_id UK
        text status "onboarding, pending_approval, approved"
        integer is_admin
        text llm_provider
        text llm_api_key_encrypted "AES-256-GCM"
        text webhook_api_key UK
    }
    transactions {
        text id PK
        text user_id FK
        integer amount "cents, original currency"
        integer amount_sgd "cents, normalized"
        text merchant
        text category
        text source "text, voice, apple_pay, recurring, split"
        text recurring_id "idempotency key for the daily job"
    }
    split_sessions {
        text chat_id PK
        text state "JSON, expires after 2 hours idle"
        integer updated_at
    }
```

`split_sessions` is keyed by Telegram chat rather than by user. `reject()`
clears it along with the user's other rows.

## Design decisions worth knowing

- **Every inbound route checks a secret.** `/api/telegram` checks Telegram's
  secret-token header, `/api/cron/*` checks Vercel's `Bearer CRON_SECRET`, and
  `/api/apple-pay` checks each user's own key. Each one refuses to run if its
  secret isn't configured, rather than running unauthenticated. Otherwise a
  forged update could `/approve` a stranger, and anyone could trigger a digest
  to every user.
- **Foreign keys are not relied on.** SQLite only enforces them per
  connection, and Turso's remote sessions aren't pinned to one connection. The
  schema still declares `ON DELETE CASCADE`, but `reject()` and
  `removeBudget()` delete child rows explicitly, in one atomic `batch`.
- **Nothing lives in process memory between requests.** On Vercel, consecutive
  messages can reach different function instances, so the `/split`
  conversation is stored in `split_sessions`. It expires after two idle hours,
  because while a split is active it captures every text message. The price
  cache stays in memory and just gets rebuilt.
- **The daily jobs are idempotent.** The recurring job skips any charge whose
  `recurring_id` was already logged today. A cron call can arrive twice, and
  the standalone process runs the job both at startup and at midnight.
- **The timezone is pinned in code.** Vercel reserves `TZ` and runs in UTC, so
  the config sets `process.env.TZ = APP_TIMEZONE` before any date math. The
  Vercel Cron schedules are UTC: `0 14 * * *` = 22:00 SGT digest, and
  `0 16 * * *` = 00:00 SGT recurring charges.
- **Migrations run at build time, never on preview builds.** A deploy migrates
  Turso before the new code serves traffic. A preview branch can't apply an
  unreviewed schema change to production data.
- **`/export` is sent as a file.** The CSV is built in memory and sent as a
  Telegram document. Nothing is written to disk, which is read-only on Vercel.
