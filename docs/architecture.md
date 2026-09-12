# Architecture

Plutus AI is one TypeScript codebase that runs in two ways:

| | **Production — Vercel + Turso** | **Local / self-hosted — standalone process** |
|---|---|---|
| Entrypoint | [`src/app.ts`](../src/app.ts), default-exports the Hono app | [`src/standalone.ts`](../src/standalone.ts), one long-running Node process |
| Telegram updates | Telegram **pushes** them to `POST /api/telegram` (webhook) | The process **long-polls** Telegram |
| Scheduled jobs | **Vercel Cron** calls `GET /api/cron/recurring`, `/digest` and `/review` | **node-cron** inside the process |
| Database | **Turso** (hosted libSQL), Tokyo | A local SQLite **file** (`file:./data/pluto.db`) |
| Migrations | During the Vercel build (`npm run vercel-build`) | On process startup |
| Apple Pay URL | `https://<project>.vercel.app/api/apple-pay` | `http://localhost:3000/api/apple-pay` (tunnel it to reach it from a phone) |

Both modes share every handler, service and query. The only differences are how
updates arrive and what triggers the scheduled jobs.

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
        cron["Vercel Cron<br/>daily 14:00 and 16:00 UTC,<br/>01:00 UTC on the 1st"]
        rtg["POST /api/telegram"]
        rap["POST /api/apple-pay"]
        rcron["GET /api/cron/recurring<br/>GET /api/cron/digest<br/>GET /api/cron/review"]
        app["Hono app (src/app.ts)<br/>one Vercel Function"]
        rtg --> app
        rap --> app
        rcron --> app
        cron --> rcron
    end

    turso[("Turso libSQL<br/>aws-ap-northeast-1 (Tokyo)")]
    gemini["Google Gemini API<br/>each user's own key"]
    prices["CoinGecko<br/>crypto prices"]
    fxapi["exchangerate-api.com<br/>SGD rates"]

    tg -- "text, voice, photos, files, button presses" --> tgapi
    tgapi -- "webhook + secret header" --> rtg
    ios -- "HTTPS + the user's x-api-key" --> rap
    app -- "replies, message edits, file downloads" --> tgapi
    app -- "SQL over HTTPS" --> turso
    app -- "classify, read receipts, transcribe, advise" --> gemini
    app -- "crypto prices" --> prices
    app -- "exchange rates, cached a day" --> fxapi
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
        crons["node-cron<br/>00:00 recurring, 22:00 digest,<br/>09:00 on the 1st review"]
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

    U->>T: "Grab 18 yesterday"
    T->>F: POST /api/telegram with secret header
    F->>F: Check secret, bot.init() once per instance
    F-->>T: 200 OK, acknowledged immediately
    Note over F: The rest runs in waitUntil, so a slow Gemini call<br/>can't make Telegram time out and redeliver
    F->>DB: authMiddleware, find user by chat_id
    F->>G: classifyUserMessage (with today's date)<br/>intent = expense, category = Transport, date = yesterday
    F->>DB: Your last category for "Grab", if any
    Note over F: Your history wins, then the classifier's category —<br/>no second Gemini call to categorize
    F->>DB: Insert transaction (integer SGD cents, spent_at = yesterday)
    F->>DB: Budget alerts for Transport and Overall
    F->>T: sendMessage("Logged S$18.00 ...", [Change category] [Undo])
    T->>U: Reply with buttons
```

## A button press

```mermaid
sequenceDiagram
    autonumber
    actor U as You (Telegram)
    participant T as Telegram Bot API
    participant F as Vercel Function
    participant DB as Turso

    U->>T: Tap "Change category", then "Food"
    T->>F: callback_query, data "t:s:c:<transaction id>:Food"
    F->>DB: Update that transaction, scoped to your user id
    F->>DB: Budget alerts for the new category
    F->>T: answerCallbackQuery("Moved to Food") + editMessageText
    T->>U: The same message, updated
```

The buttons carry the transaction id, so no function instance has to remember
what a message was about. Replying to a message with buttons works the same
way: Telegram includes the replied-to message's buttons, and the correction
goes to that transaction.

## The scheduled jobs

```mermaid
sequenceDiagram
    participant C as Vercel Cron
    participant F as Vercel Function
    participant DB as Turso
    participant P as CoinGecko
    participant G as Gemini (each user's key)
    participant T as Telegram Bot API

    C->>F: GET /api/cron/digest (Bearer CRON_SECRET)
    F->>DB: listApproved()
    loop Each approved user, failures isolated per user
        F->>DB: Today's spending, budgets, recurring charges, holdings
        F->>P: Crypto prices (stocks use their statement price)
        F->>G: Summary line and grounded portfolio market take
        F->>T: sendMessage(that user's chat)
    end
    F-->>C: 200

    C->>F: GET /api/cron/review on the 1st (Bearer CRON_SECRET)
    loop Each approved user with last month logged
        F->>DB: Last month and the month before, income, budgets
        F->>T: sendMessage(the month in review), no LLM call
    end
    F-->>C: 200
```

The recurring-charge job (`/api/cron/recurring`, midnight) works the same way:
it logs each due charge once, then pushes any budget alert it triggers.

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
        hnd["handlers: text, voice, document,<br/>receipt, callback"]
        kb["keyboards.ts<br/>buttons and callback data"]
    end

    subgraph domain["Domain services, all scoped by userId"]
        exp["expense"]
        inc["income"]
        bud["budget"]
        rev["review"]
        port["portfolio"]
        spl["split"]
        dig["digest"]
        usr["users"]
        sch["scheduler/recurring"]
    end

    llm["src/llm<br/>provider.ts to gemini.ts"]
    db["src/db<br/>Drizzle + libSQL"]
    fxmod["src/fx<br/>exchange rates"]

    appts --> http
    stand --> http
    stand --> botmod
    stand --> sch
    rtel --> botmod
    rcr --> sch
    rcr --> dig
    rcr --> rev
    rapp --> exp
    botmod --> domain
    domain --> llm
    domain --> db
    domain --> fxmod
    llm --> usr
```

## Data model

```mermaid
erDiagram
    users ||--o{ transactions : owns
    users ||--o{ income : owns
    users ||--o{ budgets : owns
    users ||--o{ budget_alerts : owns
    users ||--o{ holdings : owns
    users ||--o{ recurring_transactions : owns
    budgets ||--o{ budget_alerts : "80%, 100% and pace, once a month each"
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
        text source "text, voice, receipt, apple_pay, recurring, split"
        text recurring_id "idempotency key for the daily job"
        integer spent_at "when the money went; totals use this"
        integer created_at "when it was logged; latest uses this"
    }
    income {
        text id PK
        text user_id FK
        integer amount "cents, original currency"
        integer amount_sgd "cents, normalized"
        text source "e.g. Salary"
        integer received_at
    }
    budgets {
        text id PK
        text user_id FK
        text category "a category, or Overall"
        integer amount_sgd "cents, monthly"
    }
    split_sessions {
        text chat_id PK
        text state "JSON, expires after 2 hours idle"
        integer updated_at
    }
    holdings {
        text id PK
        text user_id FK
        text symbol
        real quantity
        text broker "normalized, e.g. ibkr; null if entered in chat"
        real price "per unit, from the statement"
        integer price_as_of "the statement date"
    }
    fx_rates {
        text id PK "SGD"
        text rates "JSON, units per 1 SGD"
        integer fetched_at
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
- **Button data is untrusted.** A button's callback data comes back from the
  client, so every action it triggers looks the transaction up by id *and* the
  pressing user's id. A forged id for someone else's expense finds nothing.
- **An expense has two times.** `spent_at` is when the money was spent
  ("yesterday", a receipt's date); totals, budgets and the review use it.
  `created_at` is when it was logged; `/undo` and `/recent` use that. Queries
  read `coalesce(spent_at, created_at)`, because the build migrates the
  database while the previous deployment is still logging rows without
  `spent_at`.
- **Categorizing is cheap.** A merchant the user has logged before takes its
  last category (corrections included) with no LLM call; a new one takes the
  category the classifier already worked out. So a chat expense costs one
  Gemini call, and a known Apple Pay merchant none.
- **Foreign keys are not relied on.** SQLite only enforces them per
  connection, and Turso's remote sessions aren't pinned to one connection. The
  schema still declares `ON DELETE CASCADE`, but `reject()` and
  `removeBudget()` delete child rows explicitly, in one atomic `batch`.
- **Nothing lives in process memory between requests.** On Vercel, consecutive
  messages can reach different function instances, so the `/split`
  conversation is stored in `split_sessions`, and buttons carry their own
  context. A split expires after two idle hours, because while it's active it
  captures every text message and photo. The price cache stays in memory and
  just gets rebuilt.
- **The scheduled jobs are idempotent where it matters.** The recurring job
  skips any charge whose `recurring_id` was already logged today, because a
  cron call can arrive twice and the standalone process runs the job both at
  startup and at midnight. A duplicated digest or review is only a repeated
  message, so those aren't deduplicated.
- **The timezone is pinned in code.** Vercel reserves `TZ` and runs in UTC, so
  the config sets `process.env.TZ = APP_TIMEZONE` before any date math. The
  Vercel Cron schedules are UTC: `0 14 * * *` = 22:00 SGT digest,
  `0 16 * * *` = 00:00 SGT recurring charges, `0 1 1 * *` = 09:00 SGT on the
  1st for the month review.
- **Migrations run at build time, never on preview builds.** A deploy migrates
  Turso before the new code serves traffic. A preview branch can't apply an
  unreviewed schema change to production data.
- **`/export` is sent as a file.** The CSV is built in memory and sent as a
  Telegram document. Nothing is written to disk, which is read-only on Vercel.
- **Stocks are valued at statement prices, not live quotes.** A statement
  from any broker, in any layout, is read by the user's own model into
  positions with a unit price and a date, and the next statement from the same
  broker replaces them. Only crypto is priced live.
- **Exchange rates are cached for a day in the database**, not only in
  memory. On Vercel a memory-only cache would call the API on almost every
  cold start, and the free plan allows 1,500 requests a month.
