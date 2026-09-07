# PLUTO-09: Multi-User Platform & BYOK — Design

Source requirements: [docs/tasks/09-multi-users.md](../../tasks/09-multi-users.md)

## Goal

Turn Plutus AI from a single-owner personal bot into a small
multi-tenant server: any Telegram chat can register, bring their own
LLM provider + API key, and get isolated expense/budget/portfolio
data, gated behind admin approval. Foundational for PLUTO-08 (expense
splitting only makes sense with more than one account) and touched by
PLUTO-10 (per-user portfolio advice).

## Scope decisions (resolved during brainstorming)

- **Interface stays Telegram-only, multi-chat.** No web/API layer.
  Any chat that messages the bot can register; `chat_id` remains the
  identity key, just no longer compared against a single allowlisted
  value.
- **Onboarding is bot-conversation-driven (`/setup`), not a web form.**
  State lives on the `users` row itself (`status: 'onboarding' |
  'pending_approval' | 'approved'`) rather than a conversation-plugin
  dependency — simpler given the flow is only two or three messages
  deep.
- **Three providers at launch: Gemini, OpenAI, Anthropic**, behind one
  `LLMProvider` interface (`generateText`), each with its own model
  pinned the same way `gemini-3.6-flash` already is.
- **API keys are encrypted at rest** (AES-256-GCM, key from a new
  required `ENCRYPTION_KEY` env var), not stored plaintext — this is a
  small self-hosted server, but a BYOK secret sitting in a raw DB dump
  unencrypted was judged not worth the small implementation cost to
  avoid.
- **Access is admin-approve-by-chat_id gated**, not open registration
  or invite codes. A new `ADMIN_CHAT_ID` env var (replacing
  `TELEGRAM_AUTHORIZED_CHAT_ID`) designates the admin explicitly and
  is required whenever `TELEGRAM_BOT_TOKEN` is set — without it
  there's no way to approve anyone, including the first user. That
  chat's completed `/setup` auto-approves as `is_admin=true` rather
  than going through the pending queue itself.
- **Key validation is live**, not just a format check — one minimal
  test call against the chosen provider at `/setup` time, so a
  typo'd key is caught immediately instead of surfacing later as a
  confusing classification failure.
- **Fresh start, no data migration.** Existing single-user data in
  `./data/pluto.db` is not backfilled with a `user_id` — every user,
  including the admin, re-registers via `/setup`. Simpler than
  reconciling a real migration for a personal dataset that's cheap to
  recreate.
- **`expense/service.ts` and `portfolio/service.ts` unify onto
  Drizzle**, retiring `expense/service.ts`'s own raw
  `better-sqlite3` connection (see CLAUDE.md's "two independent
  SQLite access paths" note). Adding `user_id` FKs to every table is
  exactly the kind of schema change CLAUDE.md flags as a decision
  point when it touches both paths — doing it once, in one place, was
  judged worth the migration effort versus hand-keeping two schemas
  in sync forever.
- **`user_config` is dropped**, not folded into `users`. It was
  already a schema-only placeholder — nothing in the codebase reads or
  writes it (confirmed by grep; only a stale comment in
  `config/currencies.ts` references it).

## Data model

```typescript
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  telegram_chat_id: text('telegram_chat_id').notNull().unique(),
  status: text('status').notNull(), // 'onboarding' | 'pending_approval' | 'approved'
  is_admin: integer('is_admin').notNull().default(0),
  llm_provider: text('llm_provider'), // 'gemini' | 'openai' | 'anthropic', null until chosen
  llm_api_key_encrypted: text('llm_api_key_encrypted'), // AES-256-GCM
  webhook_api_key: text('webhook_api_key').unique(), // generated at /setup completion, before approval
  created_at, updated_at,
});
```

`transactions`, `holdings`, `budgets`, `budget_alerts`,
`recurring_transactions` all gain `user_id` (FK → `users.id`, cascade
delete). One Drizzle migration covers the new table, the new columns,
and dropping `user_config`.

See the task doc's [Onboarding & Auth Flow](../../tasks/09-multi-users.md#onboarding--auth-flow)
and [LLM Provider Abstraction](../../tasks/09-multi-users.md#llm-provider-abstraction)
sections for the full state-machine and `LLMProvider` shape — not
duplicated here.

## Cross-cutting changes

See the task doc's [Cross-Cutting Changes](../../tasks/09-multi-users.md#cross-cutting-changes)
section for the full list (service layers, crons, webhook, config).
Notably this includes `src/portfolio/service.ts` and
`statement-parser.ts` — the portfolio tracker (PLUTO-04) is already
fully implemented single-user; this task adds `user_id` scoping and
per-user LLM provider to it, not new functionality.

## Testing

Onboarding state transitions, admin bootstrap via `ADMIN_CHAT_ID`, key
rotation on an already-approved user, cross-user data isolation across
every module (expense, budget, portfolio), and webhook API-key → user
resolution. `src/testing/geminiStub.ts` becomes provider-agnostic. Full
detail in the task doc's [Testing](../../tasks/09-multi-users.md#testing)
section.

## Out of scope

See the task doc's [Out of Scope](../../tasks/09-multi-users.md#out-of-scope)
section — no web UI, no invite codes, no data backfill, no per-user
rate limiting, and PLUTO-08 itself is a separate task this only
enables.
