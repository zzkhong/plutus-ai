# PLUTO-09: Multi-User Platform & BYOK

| Field | Value |
|-------|-------|
| Module | Multi-User Platform / Bring-Your-Own-LLM-Key |
| Priority | P0 — Foundational for PLUTO-08 (Expense Split) |
| Dependencies | PLUTO-01 (Foundation), PLUTO-02 (Telegram Bot), PLUTO-03 (Expense Engine), PLUTO-05 (Budget), PLUTO-06 (Daily Digest), PLUTO-07 (iOS Shortcut) — touches all of them |
| Estimated effort | Large |

---

## Description

Turns Plutus AI from a single-owner personal bot into a small
multi-tenant server: any Telegram chat can register, bring their own
LLM provider + API key (Gemini, OpenAI, or Anthropic), and get their
own isolated expense/budget/portfolio data — gated behind admin
approval. This is a prerequisite for PLUTO-08 (Expense Split), since
splitting a bill between people only makes sense once there's more
than one Plutus account.

The interface stays Telegram-only (one bot token, many chats). There
is no web UI, invite-code system, or non-Telegram provider onboarding
in this task.

---

## Status

**Slice 1 (Gemini-only multi-user core) is implemented and tested** — see
[2026-09-09-multi-user-core-slice-design.md](../superpowers/specs/2026-09-09-multi-user-core-slice-design.md).
Every criterion below is met with a provider set of one. Slice 2 —
`src/llm/openai.ts`, `src/llm/anthropic.ts`, and widening `/setup`'s
accepted provider names — is still outstanding and requires no changes to
auth, onboarding state, persistence, or any service signature.

## Acceptance Criteria

- [x] A `users` table exists; every existing per-transaction table
      (`transactions`, `holdings`, `budgets`, `budget_alerts`,
      `recurring_transactions`) has a `user_id` FK scoping every row
- [x] `expense/service.ts` is migrated off its own raw
      `better-sqlite3` connection onto the Drizzle schema/client — one
      persistence path, not two
- [x] `/setup` walks a new chat through: pick provider → paste API key
      → live-validate the key against that provider → pending admin
      approval *(slice 1 accepts `gemini` only; OpenAI/Anthropic are
      slice 2 — see the slice design doc)*
- [x] The bot best-effort deletes the user's raw API-key message
      right after processing it
- [x] `ADMIN_CHAT_ID`'s completed `/setup` is auto-approved as
      `is_admin=true`, no approval step needed (bootstrap)
- [x] Admin can `/approve <chat_id>` or `/reject <chat_id>` a pending
      user; the user is notified either way
- [x] An already-approved user can re-run `/setup` to rotate their
      provider/key without losing approval or needing re-approval
- [x] Unregistered / pending-approval chats can't reach any command or
      free-text flow except `/setup` and `/help`
- [x] `classifyUserMessage`, `inferCategory`, `parseStatement`
      (`src/portfolio/statement-parser.ts`), and the digest's
      `generateSummaryLine` all resolve their LLM call through the
      calling user's own stored provider/key, not a global
      `GOOGLE_API_KEY`
- [x] All command handlers (`/today`, `/month`, `/budget`, `/export`,
      `/undo`, `/digest`, `/portfolio`) and free-text flows only
      read/write the calling user's own rows
- [x] The recurring-transaction cron and the 10pm digest cron run once
      per approved user (not once globally), each notified on their
      own `telegram_chat_id`
- [x] `POST /api/apple-pay` resolves which user owns the `x-api-key`
      header value (`users.webhook_api_key`) and logs against that
      user, instead of checking one global `WEBHOOK_API_KEY`
- [x] User A cannot see, undo, correct, or export user B's transactions
      under any code path (covered by tests)
- [x] `GOOGLE_API_KEY` and `WEBHOOK_API_KEY` are removed from the env
      schema (no more global LLM key or webhook secret); `ENCRYPTION_KEY`
      and `ADMIN_CHAT_ID` are added

---

## Data Model

```typescript
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  telegram_chat_id: text('telegram_chat_id').notNull().unique(),
  status: text('status').notNull(), // 'onboarding' | 'pending_approval' | 'approved'
  is_admin: integer('is_admin').notNull().default(0),
  llm_provider: text('llm_provider'), // 'gemini' | 'openai' | 'anthropic', null until chosen
  llm_api_key_encrypted: text('llm_api_key_encrypted'), // AES-256-GCM, null until validated
  webhook_api_key: text('webhook_api_key').unique(), // generated at /setup completion, before approval
  created_at, updated_at,
});
```

Every existing table gains `user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' })`.
`user_config` is dropped — it's schema-only today, nothing reads or
writes it (only a stale comment in `config/currencies.ts` references
it).

One Drizzle migration covers all of the above. No backfill: this is a
fresh start, existing local data in `./data/pluto.db` is not migrated
and every user (including the admin) re-registers via `/setup`.

---

## Onboarding & Auth Flow

State lives entirely on the `users` row — no conversation-plugin
dependency:

1. **No row for this `chat_id`** → only `/setup` and `/help` respond;
   everything else replies "run /setup to get started."
2. `/setup` → creates a row with `status='onboarding'`, asks the user
   to reply with a provider name (`gemini` / `openai` / `anthropic`).
3. Next text message while `status='onboarding'` and no provider set →
   validated against the three names and stored; bot asks for the API
   key. This check happens in the text handler *before* any intent
   classification.
4. Next text message once a provider is set → treated as the API key:
   bot makes one minimal live call to that provider to confirm the key
   works.
   - **Success** → encrypt (AES-256-GCM, key from `ENCRYPTION_KEY`) and
     store, generate a unique `webhook_api_key`, set
     `status='pending_approval'` (or `status='approved', is_admin=1` if
     this chat is `ADMIN_CHAT_ID`), notify the user, and — for
     non-admins — DM the admin with the new chat_id and the
     `/approve`/`/reject` commands.
   - **Failure** → ask them to resend the key; explain briefly why
     (provider rejected it).
   - Either way, best-effort `ctx.deleteMessage()` on the key message.
5. `status='pending_approval'` → every message gets "still waiting for
   admin approval."
6. Admin's `/approve <chat_id>` → `status='approved'`, user notified.
   `/reject <chat_id>` → row deleted, user notified.
7. `status='approved'` → normal flow. `authMiddleware` resolves the
   `users` row from `ctx.chat.id` and attaches it to context; every
   handler downstream uses `user.id` to scope its data.
8. An approved user re-running `/setup` restarts from step 2 but skips
   the approval step on success — it's a key/provider rotation, not a
   new registration.

`ADMIN_CHAT_ID` (env var, replaces `TELEGRAM_AUTHORIZED_CHAT_ID`) is
required whenever `TELEGRAM_BOT_TOKEN` is set — without a designated
admin identity there's no way to approve anyone, including the first
user.

---

## LLM Provider Abstraction

```typescript
// src/llm/provider.ts
export interface LLMProvider {
  generateText(params: {
    systemInstruction: string;
    prompt: string;
    timeoutMs?: number;
  }): Promise<string>;
}

export function getProviderForUser(user: User): LLMProvider;
// decrypts user.llm_api_key_encrypted, returns the matching
// GeminiProvider / OpenAIProvider / AnthropicProvider, each pinned to
// that provider's own current fast/cheap model (exact model ids
// confirmed against provider docs at implementation time).
```

`classifyUserMessage`, `inferCategory`, `correctLastTransaction`'s
re-categorization step, `parseStatement`, the digest's
`generateSummaryLine`, and the
`/setup` key-validation call all take a `userId` (or a resolved
`LLMProvider`) instead of constructing `GoogleGenerativeAI` directly
against `config.GOOGLE_API_KEY`. The existing `safeJsonParse`/JSON
extraction helpers stay as-is — they're already provider-agnostic.

A failed/timed-out provider call still degrades the same way it does
today (`serviceError: true` → generic user-facing error), regardless
of which provider is behind it.

---

## Cross-Cutting Changes

- **Service layers** (`expense/service.ts`, `budget/service.ts`,
  `portfolio/service.ts`): every exported function gains a leading
  `userId` parameter and every query is scoped `WHERE user_id = ?`.
  "Most recent transaction" in `undoLastTransaction`/
  `correctLastTransaction` becomes most-recent *for that user*;
  `replaceHoldingsForBroker` only ever wipes/inserts that user's rows
  for the given broker. Note: the portfolio module (`src/portfolio/`)
  is already fully implemented (statement import, price fetching, net
  worth/allocation) — PLUTO-04 shipped single-user; this task only
  adds the `user_id` scoping and per-user LLM provider to it, not new
  functionality.
- **Crons**: the recurring-transaction fire job and the 10pm digest
  job iterate all `status='approved'` users and run their existing
  per-user logic against each, sending via
  `bot.api.sendMessage(user.telegram_chat_id, ...)` (proactive send,
  not `ctx.reply`) — one user's failure doesn't block another's run.
- **Webhook**: `apiKeyAuthMiddleware` looks up the user owning the
  `x-api-key` value instead of comparing against one global secret,
  and also requires `status='approved'` — a key generated during
  onboarding shouldn't work before the account is approved, and a
  rejected/removed user's key stops working immediately — then calls
  `logExpense(userId, ...)`. `docs/setup/ios-shortcut-setup.md`
  needs a follow-up update once this ships, since the setup steps
  currently reference a single shared `WEBHOOK_API_KEY`.
- **Config** (`src/config/env.ts`): remove `GOOGLE_API_KEY` and
  `WEBHOOK_API_KEY` (no longer global secrets); add `ENCRYPTION_KEY`
  (required) and `ADMIN_CHAT_ID` (required whenever
  `TELEGRAM_BOT_TOKEN` is set).

---

## Files to Create / Modify

```
src/
├── users/
│   ├── service.ts            # createUser, setProvider, setApiKey, approve,
│   │                          # reject, findByChatId, findByWebhookKey, listApproved
│   └── crypto.ts              # encrypt/decrypt against ENCRYPTION_KEY
├── llm/
│   ├── provider.ts            # LLMProvider interface + getProviderForUser
│   ├── gemini.ts
│   ├── openai.ts
│   └── anthropic.ts
├── bot/
│   ├── middleware/auth.ts     # rewritten: chat_id -> users row resolution
│   ├── commands/setup.ts      # /setup
│   ├── commands/approve.ts    # /approve, /reject (admin-only)
│   └── ai.ts                  # classifyUserMessage takes userId
├── expense/
│   ├── service.ts             # migrated onto Drizzle, user_id-scoped
│   └── categorizer.ts         # inferCategory takes userId
├── portfolio/
│   ├── service.ts             # user_id-scoped (already Drizzle-based)
│   └── statement-parser.ts    # parseStatement takes userId
├── digest/                    # generateSummaryLine takes userId; scheduler loops users
├── scheduler/recurring.ts     # loops approved users
├── webhook/
│   ├── auth.ts                 # api key -> user lookup
│   └── routes/apple-pay.ts     # passes resolved userId to logExpense
├── db/
│   ├── schema.ts               # users table, user_id columns, drop user_config
│   └── migrations/             # new drizzle-kit migration
└── config/env.ts               # ENCRYPTION_KEY, ADMIN_CHAT_ID; drop GOOGLE_API_KEY, WEBHOOK_API_KEY
```

---

## Testing

- `src/testing/geminiStub.ts` becomes provider-agnostic (stub
  `LLMProvider.generateText` or per-provider `fetch`, whichever stays
  cleanest once the concrete providers exist).
- Every existing test that logs a transaction/budget creates a test
  user first and threads its id through.
- New coverage: onboarding state transitions (provider pick → key
  validation success/failure → pending → approve/reject), admin
  bootstrap via `ADMIN_CHAT_ID`, key rotation on an already-approved
  user, cross-user data isolation (user A can't read/undo/export user
  B's data), and webhook API-key → user resolution.

---

## Out of Scope

- A web UI or any non-Telegram onboarding surface.
- Invite codes — gating is admin-approves-by-chat_id only.
- Migrating/backfilling existing single-user data.
- Per-user rate limiting or LLM spend tracking.
- PLUTO-08 (Expense Split) itself — this task only makes it possible.
