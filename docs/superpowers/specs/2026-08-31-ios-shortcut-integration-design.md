# PLUTO-07: iOS Shortcut Integration — Design

Source requirements: [docs/tasks/07-ios-shortcut-integration.md](../../tasks/07-ios-shortcut-integration.md)

## Goal

An HTTP webhook endpoint that receives an Apple Pay transaction from
an iOS Shortcuts automation ("When Apple Pay is Used"), logs it
through the expense engine, and sends a Telegram confirmation — the
primary, near-zero-effort input channel for day-to-day spending.

## Scope decisions (resolved during initial implementation)

- **A separate Hono app on its own port, not reusing the Telegram bot's
  transport.** `src/webhook/index.ts` builds an independent `Hono` app
  served via `@hono/node-server` on `config.PORT`, started from
  `src/index.ts` alongside the existing schedulers. It shares nothing
  with grammy's long-polling loop except the `Bot` instance itself
  (passed in for sending the confirmation message) — the two run
  concurrently and independently, so a webhook failure can't take down
  the Telegram bot or vice versa.
- **`WEBHOOK_API_KEY` is optional in the env schema, but the server
  refuses to bind without it.** Making it a hard-required env var
  (like `GOOGLE_API_KEY`) would have broken every existing setup and
  test that doesn't touch the webhook. Instead, `startWebhookServer`
  checks `config.WEBHOOK_API_KEY` itself: if unset, it logs an error
  and returns `null` without calling `serve(...)` at all — the rest of
  the app (bot, schedulers) still starts normally. This mirrors the
  existing pattern for `TELEGRAM_BOT_TOKEN` (the bot is skipped, not
  the whole app, when it's absent).
- **Auth is a simple shared-secret header, not OAuth.** `apiKeyAuthMiddleware`
  compares the `x-api-key` header against `config.WEBHOOK_API_KEY`
  with strict equality; any mismatch or missing header returns `401`
  before the handler runs. Sufficient for a single-user personal tool
  whose endpoint is only reachable via a Cloudflare Tunnel URL known
  only to the user.
- **Amount parsing treats a currency prefix as an explicit override.**
  POS terminals or the Shortcut itself may hand back an amount string
  like `"RM 45.00"` rather than a bare number. `parseAmount` (in
  `routes/apple-pay.ts`) runs the existing `parseExplicitCurrency`
  helper (from `src/expense/currency-resolver.ts`, added specifically
  for this use case — see PLUTO-03's design doc) against the raw
  string *before* stripping non-numeric characters, so a currency
  prefix wins over card-based resolution. Without a prefix, currency
  resolution falls through to `logExpense`'s normal
  card-name → text-scan → SGD-default chain, unchanged.
- **The webhook logs the transaction before attempting Telegram
  delivery, and a Telegram failure never fails the HTTP response.**
  `createApplePayHandler` calls `logExpense` first; only if that
  succeeds does it attempt `sendConfirmation`, whose own try/catch
  logs and swallows any Telegram error. The iOS Shortcut always gets a
  `200` with the logged transaction as long as `logExpense` itself
  succeeded — a missed confirmation message is a secondary, log-only
  failure, not something that should make the Shortcut think the
  expense wasn't recorded (it was).
- **Deployment via Cloudflare Tunnel quick tunnel, not a named tunnel
  or a cloud host.** `cloudflared tunnel --url http://localhost:PORT`
  needs no Cloudflare account or domain, at the cost of a public URL
  that changes every time the tunnel restarts (requiring the Shortcut's
  URL to be re-pasted). Documented as an acceptable tradeoff for a
  single-user personal tool in `docs/setup/ios-shortcut-setup.md`; a
  named tunnel is called out as a possible future upgrade if the churn
  becomes annoying.
- **No request body size limit, rate limiting, or replay protection
  beyond the API key.** Out of scope for a personal-use endpoint
  behind a tunnel URL only the user knows.

## Module layout

```
src/webhook/
├── index.ts               # createWebhookApp(bot), startWebhookServer(bot)
├── auth.ts                # apiKeyAuthMiddleware — x-api-key vs config.WEBHOOK_API_KEY
├── routes/
│   └── apple-pay.ts        # createApplePayHandler(bot) — POST /api/apple-pay
├── types.ts                # ApplePayPayload, ApplePayResponse, WebhookErrorResponse
└── webhook.test.ts          # node:test suite (Hono's app.request(), no real server bind)

docs/setup/ios-shortcut-setup.md  # User-facing setup guide (tunnel + Shortcut steps)
```

### `index.ts`

```typescript
createWebhookApp(bot: Bot | null): Hono
startWebhookServer(bot: Bot | null): ServerType | null
```

`createWebhookApp` registers `GET /api/health` (no auth, returns
`{ status: 'ok' }`) and `POST /api/apple-pay` (behind
`apiKeyAuthMiddleware`, handled by `createApplePayHandler(bot)`) —
factored out from `startWebhookServer` specifically so tests can drive
the app via Hono's `app.request(...)` without binding a real port.
`startWebhookServer` checks `config.WEBHOOK_API_KEY` first: if unset,
logs an error (`'Webhook server not started: WEBHOOK_API_KEY is not
configured...'`) and returns `null`; otherwise builds the app and
calls `serve({ fetch: app.fetch, port: Number(config.PORT) }, ...)`,
logging the bound port.

### `auth.ts`

```typescript
apiKeyAuthMiddleware(c: Context, next: Next): Promise<Response | void>
```

Reads the `x-api-key` header; if it's missing or doesn't strictly
equal `config.WEBHOOK_API_KEY`, responds `401` with
`{ status: 'error', message: 'Unauthorized' }` and does not call
`next()`. Otherwise calls `next()`.

### `routes/apple-pay.ts`

```typescript
createApplePayHandler(bot: Bot | null): (c: Context) => Promise<Response>
```

Parses the JSON body (`400` on invalid JSON); validates `amount`
(non-empty string, strips non-numeric characters after checking for an
explicit currency prefix via `parseExplicitCurrency`, must parse to a
finite number `> 0`), `merchant`, and `card` (all required — `400` if
any is missing/blank). On success, calls
`logExpense({ amount, currency, merchant, cardName: card, source: 'apple_pay' })`,
then `sendConfirmation(bot, transaction)` (best-effort, errors
swallowed and logged), then responds `200` with
`{ status: 'logged', transaction: { amount, currency, merchant,
category } }` (amount converted back to a decimal dollar value for the
response body, unlike the cents stored internally). A thrown error
from `logExpense` itself is caught and returns `500`
`{ status: 'error', message: 'Failed to log transaction' }`.

`sendConfirmation` no-ops silently if `bot` is `null` or
`config.TELEGRAM_AUTHORIZED_CHAT_ID` is unset (nothing to send to);
otherwise sends `"Spent {formatted amount} at {merchant} — {category}"`
via `bot.api.sendMessage`, matching the task doc's example message
format exactly (`formatCurrency` from `src/config/currencies.ts`
renders the symbol + 2-decimal amount).

### `types.ts`

```typescript
interface ApplePayPayload { amount: string; merchant: string; card: string; }
interface ApplePayResponse { status: 'logged'; transaction: { amount: number; currency: string; merchant: string; category: string; }; }
interface WebhookErrorResponse { status: 'error'; message: string; }
```

## Data model

No schema changes — this module is a new entry point into
`logExpense` (PLUTO-03), tagging every transaction it creates with
`source: 'apple_pay'`. Currency resolution reuses the existing
card-name mapping (`DEFAULT_CARD_CURRENCY_MAP`) unchanged; the only
new resolver behavior is treating a currency prefix on the `amount`
string itself as an override (via `parseExplicitCurrency`).

## Wiring into the rest of the app

`src/index.ts`: `startWebhookServer(plutoBot ? plutoBot.getBot() : null)`
is called alongside `startRecurringScheduler(...)` and
`startDigestScheduler(...)`, all fed the same nullable `Bot` reference
obtained via `PlutoBot.getBot()` (PLUTO-02). The webhook server binds
its own port independent of whether the Telegram bot itself started —
if `TELEGRAM_BOT_TOKEN` is absent, transactions still log via the
webhook, just without a Telegram confirmation.

`.env.example` gains a `WEBHOOK_API_KEY` entry with a comment
explaining it's required for the endpoint to accept requests (but not
for the rest of the app to start).

## Testing

`src/webhook/webhook.test.ts` (registered in `package.json`'s `test`
script), driving `createWebhookApp(...)` directly via Hono's
`app.request(...)` — no real network bind, so tests run fully
in-process:

- `GET /api/health` returns `200 { status: 'ok' }` without auth.
- `POST /api/apple-pay` rejects a request with no `x-api-key` header
  (`401`).
- `POST /api/apple-pay` rejects a request with the wrong `x-api-key`
  (`401`).
- `POST /api/apple-pay` rejects a payload missing a required field
  (`400`).
- `POST /api/apple-pay` rejects a non-numeric `amount` (`400`).
- `POST /api/apple-pay` logs the transaction, maps the card to a
  currency, and sends a Telegram confirmation matching
  `"Spent S$4.50 at Ya Kun Kaya Toast"` through a fake `bot.api`.
- `POST /api/apple-pay` treats an amount string with a currency prefix
  (`"RM 45.00"`) as an explicit `MYR` override, independent of the
  card's mapped currency.
- `POST /api/apple-pay` returns `500` (not a crash) when `logExpense`
  fails — simulated by pointing `config.DATABASE_URL` at an
  unwritable path for the duration of the test, then restoring it.

## Out of scope

- A named Cloudflare Tunnel (stable URL) — quick tunnel only; the
  churn of re-pasting a new URL after every restart is accepted.
- Rate limiting, request size limits, or replay protection beyond the
  shared-secret header.
- Any payload fields beyond `amount`/`merchant`/`card` — no note,
  no explicit currency field distinct from a prefix on `amount`.
- Reusing this same Hono server for Telegram's own webhook mode — the
  Telegram bot stays on long polling (see PLUTO-02); this HTTP server
  exists solely for the iOS Shortcut endpoint.
- A `GET`/list endpoint for recent webhook-logged transactions — the
  Shortcut is fire-and-forget; checking history happens via `/today`
  or `/month` in the bot.
