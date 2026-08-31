# iOS Shortcut Integration (PLUTO-07) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking — this plan is retrospective, documenting work already completed, so every step is checked off.

**Goal:** Ship an HTTP webhook endpoint that an iOS Shortcuts "Apple Pay is Used" automation can POST to, logging the transaction through the expense engine and sending a Telegram confirmation, with the endpoint disabled (not the whole app) when its API key isn't configured.

**Architecture:** A standalone Hono app (`src/webhook/`), served via `@hono/node-server` on `config.PORT`, independent of the Telegram bot's long-polling loop. `POST /api/apple-pay` sits behind a shared-secret `x-api-key` middleware, parses the payload, calls the existing `logExpense` (PLUTO-03) with `source: 'apple_pay'`, and best-effort sends a Telegram confirmation through the `Bot` instance passed in from `src/index.ts`. `GET /api/health` is unauthenticated, for tunnel/reachability checks.

**Tech Stack:** TypeScript, Hono + `@hono/node-server`, grammy `Bot`/`Api` (confirmation delivery only), node's built-in test runner (via Hono's in-process `app.request()`, no real port binding needed for tests).

**Spec:** [docs/superpowers/specs/2026-08-31-ios-shortcut-integration-design.md](../specs/2026-08-31-ios-shortcut-integration-design.md)

## Global Constraints

- `WEBHOOK_API_KEY` is optional in the env schema (so it doesn't break existing setups/tests), but `startWebhookServer` must refuse to bind the port at all if it's missing — logging an error and returning `null`, not throwing and not silently accepting unauthenticated requests.
- The webhook must always log the transaction before attempting Telegram delivery, and a Telegram send failure must never turn a successful log into a failed HTTP response — the iOS Shortcut only needs to know whether the *expense was recorded*, not whether the confirmation was delivered.
- Auth is a strict-equality shared-secret header (`x-api-key` vs `config.WEBHOOK_API_KEY`) — no OAuth, no per-request nonce, no rate limiting.
- Reuse existing expense-engine currency resolution (`resolveCurrency`, `DEFAULT_CARD_CURRENCY_MAP`) unchanged; the only new resolver behavior needed is treating a currency prefix on the `amount` field itself as an explicit override, via the existing `parseExplicitCurrency` helper.
- New test files must be registered in `package.json`'s `test` script.

---

## File Structure

```
src/webhook/index.ts                (implemented) — createWebhookApp, startWebhookServer
src/webhook/auth.ts                 (implemented) — apiKeyAuthMiddleware
src/webhook/routes/apple-pay.ts     (implemented) — createApplePayHandler
src/webhook/types.ts                (implemented) — ApplePayPayload, ApplePayResponse, WebhookErrorResponse
src/webhook/webhook.test.ts         (implemented)
src/config/env.ts                   (modified) — WEBHOOK_API_KEY added (optional)
src/index.ts                        (modified) — starts the webhook server alongside the schedulers
.env.example                        (modified) — WEBHOOK_API_KEY entry + comment
docs/setup/ios-shortcut-setup.md    (implemented) — user-facing setup guide
docs/tasks/07-ios-shortcut-integration.md  (modified) — acceptance criteria checked off
package.json                        (modified) — registers src/webhook/webhook.test.ts
```

---

### Task 1: Webhook payload types

**Files:** `src/webhook/types.ts`

- [x] **Step 1: Define the payload/response shapes**

```typescript
export interface ApplePayPayload { amount: string; merchant: string; card: string; }
export interface ApplePayResponse {
  status: 'logged';
  transaction: { amount: number; currency: string; merchant: string; category: string; };
}
export interface WebhookErrorResponse { status: 'error'; message: string; }
```

`amount` on the incoming payload is a `string` deliberately — POS
terminals and the Shortcut's own magic variables hand back amounts as
text, sometimes with a currency prefix (`"RM 45.00"`), so parsing is
the handler's job, not the type's.

---

### Task 2: API key auth middleware

**Files:** `src/webhook/auth.ts`

**Interfaces:**
- Consumes: `config.WEBHOOK_API_KEY` (Task 4).
- Produces: `apiKeyAuthMiddleware(c: Context, next: Next): Promise<Response | void>`.

- [x] **Step 1: Implement**

```typescript
export async function apiKeyAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
  const providedKey = c.req.header('x-api-key');
  if (!providedKey || providedKey !== config.WEBHOOK_API_KEY) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }
  await next();
}
```

- [x] **Step 2: Verify**

Covered by `webhook.test.ts`'s missing-header and wrong-key cases
(Task 6).

---

### Task 3: Apple Pay route handler

**Files:** `src/webhook/routes/apple-pay.ts`

**Interfaces:**
- Consumes: `logExpense` from `../../expense/service` (PLUTO-03), `parseExplicitCurrency` from `../../expense/currency-resolver` (PLUTO-03), `config`/`formatCurrency` from `../../config` (PLUTO-01), grammy `Bot`.
- Produces: `createApplePayHandler(bot: Bot | null): (c: Context) => Promise<Response>`.

- [x] **Step 1: Amount parsing**

```typescript
function parseAmount(raw: unknown): { amount: number; currency?: Currency } | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const currency = parseExplicitCurrency(raw); // check prefix BEFORE stripping
  const numeric = raw.replace(/[^0-9.]/g, '');
  const amount = Number.parseFloat(numeric);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { amount, currency };
}
```

- [x] **Step 2: Confirmation sender**

```typescript
async function sendConfirmation(bot: Bot | null, transaction: Transaction): Promise<void> {
  if (!bot || !config.TELEGRAM_AUTHORIZED_CHAT_ID) return;
  const amountLabel = formatCurrency(transaction.amount, transaction.currency);
  const message = `Spent ${amountLabel} at ${transaction.merchant} — ${transaction.category}`;
  try {
    await bot.api.sendMessage(config.TELEGRAM_AUTHORIZED_CHAT_ID, message);
  } catch (error) {
    logger.error('Failed to send Apple Pay confirmation via Telegram', error);
  }
}
```

Errors here are caught and logged, never rethrown — a failed
confirmation must not affect the HTTP response, since the transaction
is already logged by this point.

- [x] **Step 3: The handler**

```typescript
export function createApplePayHandler(bot: Bot | null) {
  return async (c: Context): Promise<Response> => {
    let payload: Partial<ApplePayPayload>;
    try { payload = await c.req.json(); }
    catch { return c.json({ status: 'error', message: 'Invalid JSON payload' }, 400); }

    const parsedAmount = parseAmount(payload.amount);
    const merchant = typeof payload.merchant === 'string' ? payload.merchant.trim() : '';
    const card = typeof payload.card === 'string' ? payload.card.trim() : '';

    if (!parsedAmount || !merchant || !card) {
      return c.json({ status: 'error', message: 'amount, merchant, and card are required' }, 400);
    }

    try {
      const transaction = await logExpense({
        amount: parsedAmount.amount, currency: parsedAmount.currency,
        merchant, cardName: card, source: 'apple_pay',
      });
      await sendConfirmation(bot, transaction);
      return c.json({
        status: 'logged',
        transaction: { amount: transaction.amount / 100, currency: transaction.currency, merchant: transaction.merchant, category: transaction.category },
      }, 200);
    } catch (error) {
      logger.error('Failed to log Apple Pay transaction from webhook', error);
      return c.json({ status: 'error', message: 'Failed to log transaction' }, 500);
    }
  };
}
```

Note the response's `transaction.amount` is converted back from cents
to a decimal dollar value (`transaction.amount / 100`) — matching the
task doc's documented response shape, distinct from the internal
integer-cents storage convention.

- [x] **Step 4: Verify**

Covered by `webhook.test.ts` (Task 6) — missing fields, non-numeric
amount, successful log + confirmation, currency-prefix override, and
the `logExpense`-throws-500 case.

---

### Task 4: Webhook server bootstrap and env wiring

**Files:** `src/webhook/index.ts`, `src/config/env.ts`

**Interfaces:**
- Produces: `createWebhookApp(bot: Bot | null): Hono`, `startWebhookServer(bot: Bot | null): ServerType | null`.

- [x] **Step 1: Add `WEBHOOK_API_KEY` to the env schema**

`src/config/env.ts`: `WEBHOOK_API_KEY: z.string().optional()` — added
without touching any other field, so existing setups/tests that don't
configure it are unaffected.

- [x] **Step 2: `createWebhookApp`**

```typescript
export function createWebhookApp(bot: Bot | null): Hono {
  const app = new Hono();
  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.post('/api/apple-pay', apiKeyAuthMiddleware, createApplePayHandler(bot));
  return app;
}
```

Factored out from `startWebhookServer` specifically so tests can drive
it via `app.request(...)` without needing a real port.

- [x] **Step 3: `startWebhookServer`**

```typescript
export function startWebhookServer(bot: Bot | null): ServerType | null {
  if (!config.WEBHOOK_API_KEY) {
    logger.error('Webhook server not started: WEBHOOK_API_KEY is not configured. Set it in .env to accept iOS Shortcut requests.');
    return null;
  }
  const app = createWebhookApp(bot);
  const port = Number(config.PORT);
  return serve({ fetch: app.fetch, port }, (info) => {
    logger.info(`Webhook server listening on port ${info.port}`);
  });
}
```

- [x] **Step 4: Verify**

Manual: with `WEBHOOK_API_KEY` unset, `npm run dev` logs the "not
started" error but the rest of the app (bot, schedulers) still comes
up; with it set, `curl http://localhost:3000/api/health` returns
`{"status":"ok"}`.

---

### Task 5: Wire into the application entry point

**Files:** `src/index.ts`, `.env.example`

- [x] **Step 1: Start the webhook server on boot**

```typescript
import { startWebhookServer } from './webhook';
// ...
startWebhookServer(plutoBot ? plutoBot.getBot() : null);
```

Placed alongside the existing `startRecurringScheduler(...)` and
`startDigestScheduler(...)` calls, fed the same nullable `Bot`
reference from `PlutoBot.getBot()` (PLUTO-02) — independent of whether
the Telegram bot itself started.

- [x] **Step 2: Document the env var**

`.env.example`: add `WEBHOOK_API_KEY=your_webhook_shared_secret_here`
with a comment noting it's required for `POST /api/apple-pay` to
accept requests (the server won't bind without it), distinct from the
rest of the app which starts regardless.

- [x] **Step 3: Verify**

Run: `npx tsc --noEmit`. Manual: full boot log shows both the bot
starting (if configured) and `Webhook server listening on port 3000`.

---

### Task 6: Webhook test suite

**Files:** `src/webhook/webhook.test.ts`, `package.json`

- [x] **Step 1: Write the tests**

`process.env.DATABASE_URL = './data/test-webhook.db'`,
`process.env.WEBHOOK_API_KEY = 'test-webhook-secret'`,
`process.env.TELEGRAM_AUTHORIZED_CHAT_ID = 'test-chat-id'`; delete any
stale test db; `before()` calls `runMigrations()`. A `fakeBot()` helper
returns a stub `{ api: { sendMessage } }` that records sent messages.

Tests, driven entirely via `createWebhookApp(...)` + `app.request(...)`
(no real port bind):
- `GET /api/health` → `200 { status: 'ok' }`, no auth needed.
- `POST /api/apple-pay` with no `x-api-key` header → `401`.
- `POST /api/apple-pay` with the wrong `x-api-key` → `401`.
- `POST /api/apple-pay` missing a required field (`card`) → `400`.
- `POST /api/apple-pay` with a non-numeric `amount` → `400`.
- `POST /api/apple-pay` with valid data → `200`, response body has
  `status: 'logged'`, correct amount/currency/merchant/category, and
  the fake bot recorded exactly one `sendMessage` call matching
  `/Spent S\$4\.50 at Ya Kun Kaya Toast/`.
- `POST /api/apple-pay` with `amount: "RM 45.00"` → `200`, response
  `transaction.currency === 'MYR'` (prefix override wins over the
  card's mapped currency).
- `POST /api/apple-pay` where `logExpense` fails (simulated by
  temporarily pointing `config.DATABASE_URL` at an unwritable path,
  restored in a `finally`) → `500`, `{ status: 'error', ... }`, no
  crash/unhandled rejection.

- [x] **Step 2: Register and run**

`package.json`'s `test` script gains `src/webhook/webhook.test.ts`.
Run: `npx tsx --test src/webhook/webhook.test.ts` — all tests pass,
network-free (no real HTTP bind, no external calls beyond the already-required
Gemini categorization call inside `logExpense`).

- [x] **Step 3: Full suite regression check**

Run: `npm test` — every registered test file passes.

---

### Task 7: iOS Shortcut setup documentation

**Files:** `docs/setup/ios-shortcut-setup.md`

- [x] **Step 1: Document the webhook configuration steps**

Setting `WEBHOOK_API_KEY`, starting the app, confirming
`GET /api/health` locally.

- [x] **Step 2: Document the Cloudflare Tunnel quick-tunnel setup**

Install `cloudflared`, run `cloudflared tunnel --url http://localhost:PORT`,
note the printed `*.trycloudflare.com` URL, verify reachability from
outside the local network. Explicitly documents the tradeoff (URL
changes on every tunnel restart) and that a named tunnel is a possible
future upgrade.

- [x] **Step 3: Document the iOS Shortcut itself**

Automation trigger ("Apple Pay is Used", "Ask Before Running" off),
the `Get Contents of URL` action (POST, headers `Content-Type` +
`x-api-key`, JSON body with `amount`/`merchant`/`card` from the Apple
Pay automation's magic variables), and an `If` block showing a failure
notification ("Pluto: Failed to log. Tell bot manually.") if the
request errors.

- [x] **Step 4: Document re-pasting the URL and troubleshooting**

What to do after a `cloudflared` restart; common failure modes (missing
Telegram confirmation but transaction still logged — check `/today`;
`401` → API key mismatch; unreachable → tunnel not running or URL
stale).

---

### Task 8: Final verification and doc sync

**Files:** `docs/tasks/07-ios-shortcut-integration.md`

- [x] **Step 1: Run the full test suite, type check, and build**

Run: `npm test`, `npx tsc --noEmit`, `npm run build` — all pass.

- [x] **Step 2: Update the task doc's status and acceptance criteria**

Mark `docs/tasks/07-ios-shortcut-integration.md`'s status as
implemented, check off every acceptance criterion, and record the
implementation decisions (Cloudflare Tunnel quick tunnel, separate
Hono server, `WEBHOOK_API_KEY` optional-but-gating auth failure mode,
amount-prefix parsing) directly in the doc for future reference.
