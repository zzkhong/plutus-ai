# Multi-User Core (Gemini-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Plutus AI from a single-owner bot into a multi-tenant one — any Telegram chat can `/setup` with their own Gemini API key, get admin-approved, and get fully isolated expense/budget/portfolio data — without yet adding OpenAI/Anthropic support.

**Architecture:** A new `users` table plus a `user_id` FK on every existing table; `expense/service.ts` migrates off its own raw `better-sqlite3` connection onto the shared Drizzle client so there's one persistence path; every service function gains a leading `userId` parameter; a new `LLMProvider` abstraction (currently one implementation, `GeminiProvider`) replaces every direct `GoogleGenerativeAI` construction; a rewritten `authMiddleware` resolves the calling chat's `users` row and gates access by `status`.

**Tech Stack:** TypeScript, Drizzle ORM (better-sqlite3 dialect), Grammy, `@google/generative-ai`, Node's built-in test runner, Zod.

**Spec:** [docs/superpowers/specs/2026-09-09-multi-user-core-slice-design.md](../specs/2026-09-09-multi-user-core-slice-design.md), which extends [docs/superpowers/specs/2026-09-07-multi-user-byok-design.md](../specs/2026-09-07-multi-user-byok-design.md) and [docs/tasks/09-multi-users.md](../../tasks/09-multi-users.md).

## Global Constraints

- All monetary amounts are integer cents — never floats.
- The Gemini model id is pinned to `gemini-3.6-flash` everywhere (matches every existing call site).
- No rule-based fallback on a failed/timed-out LLM call for classification, categorization, statement parsing, receipt extraction, split-instruction parsing, or voice transcription — degrade to an explicit error, never guess. **Exception:** `generateSummaryLine` (digest) keeps its pre-existing rule-based fallback; this plan does not change that.
- API keys are encrypted at rest with AES-256-GCM; the key comes from `ENCRYPTION_KEY`, a 64-character hex string (32 bytes), required unconditionally.
- `ADMIN_CHAT_ID` is required whenever `TELEGRAM_BOT_TOKEN` is set — without it nobody (including the first user) can be approved.
- No data backfill. Existing rows in a real `./data/pluto.db` are not migrated to have a `user_id` — delete that file before running the new migration against real data; every user (including the admin) re-registers via `/setup`. Test databases are unaffected since every test file deletes and recreates its own `./data/test-*.db` already.
- `/setup`'s onboarding still asks "which provider" but only `gemini` validates this slice — see the spec for why.
- New test files must be added to the `test` script in `package.json` in the same task that introduces them, or `npm test` won't run them.
- **Expect a "red window":** Task 1 adds `NOT NULL user_id` columns to `transactions`, `holdings`, `budgets`, `budget_alerts`, and `recurring_transactions`. Until Task 11 (the last of the per-module persistence migrations) lands, the *full* `npm test` suite will fail for not-yet-migrated modules — this is expected, not a regression to chase. Run the specific test file for the task you're on (`npx tsx --test <file>`) rather than the full suite until Task 11 completes; from Task 12 onward the full suite should stay green after every task.
- **Verified drizzle-kit quirks (two, both confirmed against this exact schema change, the second one during execution after the original single-step spike turned out to be incomplete):**
  1. Its generated `ALTER TABLE ... ADD user_id text NOT NULL REFERENCES users(id);` statements **silently drop `ON DELETE CASCADE`** even though the schema declares it (confirmed: SQLite itself honors `ON DELETE CASCADE` fine when present in an `ALTER TABLE ADD COLUMN` statement — this is specifically a drizzle-kit generator gap for the ADD-COLUMN diff path, not a SQLite limitation). Task 1 includes a manual fix-up step for this — don't skip it, or user deletion won't cascade.
  2. Running `db:generate` against a schema diff that **both adds a table and removes a table in the same pass** (adding `users` while dropping `user_config`) triggers drizzle-kit's rename-ambiguity heuristic (`promptNamedWithSchemasConflict`), which requires interactive TTY confirmation and hard-fails with `Error: Interactive prompts require a TTY terminal` in any non-interactive shell (confirmed in both a dispatched subagent's shell and the controller's own). **Fix: split it into two separate `db:generate` invocations** — first add `users` and the five `user_id` columns with `user_config` still present in the schema (a pure addition, generates cleanly), then in a second pass remove `user_config` from the schema and generate again (a solo drop, also generates cleanly since there's no counterpart addition in that pass to look like a rename). Task 1 is written this way — follow its step order exactly; don't try to do both in one schema edit.

## File Structure

New files:
- `src/users/types.ts` — `User`, `UserStatus`, `LLMProviderName` types
- `src/users/crypto.ts` — AES-256-GCM encrypt/decrypt
- `src/users/service.ts` — user CRUD (create, setProvider, completeSetup, approve, reject, findByChatId, findByWebhookKey, findById, listApproved)
- `src/llm/provider.ts` — `LLMProvider` interface, `ContentPart` type, `getProviderForUser`
- `src/llm/gemini.ts` — `GeminiProvider`
- `src/bot/context.ts` — `BotContext` (Grammy `Context` + `user?: User`)
- `src/bot/commands/setup.ts` — `/setup` flow
- `src/bot/commands/approve.ts` — `/approve`, `/reject`
- Test files: `src/config/env.test.ts`, `src/users/crypto.test.ts`, `src/users/service.test.ts`, `src/llm/gemini.test.ts`, `src/bot/middleware/auth.test.ts`, `src/bot/commands/setup.test.ts`, `src/bot/commands/approve.test.ts`

Modified files (grouped by task below): `src/db/schema.ts`, `src/config/env.ts`, `src/config/currencies.ts`, `.env.example`, `package.json` (new test files added incrementally), `src/expense/service.ts`, `src/expense/categorizer.ts`, `src/budget/service.ts`, `src/budget/progress.ts`, `src/budget/alerts.ts`, `src/portfolio/service.ts`, `src/portfolio/index.ts`, `src/portfolio/statement-parser.ts`, `src/digest/aggregator.ts`, `src/digest/summary.ts`, `src/digest/index.ts`, `src/scheduler/recurring.ts`, `src/webhook/auth.ts`, `src/webhook/routes/apple-pay.ts`, `src/webhook/index.ts`, `src/split/extraction.ts`, `src/split/assignment.ts`, `src/bot/commands/split.ts`, `src/bot/handlers/voice.ts`, `src/bot/handlers/text.ts`, `src/bot/handlers/document.ts`, `src/bot/middleware/auth.ts`, `src/bot/index.ts`, `src/bot/ai.ts`, `src/bot/commands/{today,month,budget,export,undo,digest,portfolio}.ts`, every test file listed in each task, `CLAUDE.md`, `README.md`, `docs/setup/ios-shortcut-setup.md`, `docs/tasks/09-multi-users.md`.

**Spec gap found during planning (flagging explicitly):** the original spec names only `classifyUserMessage`, `inferCategory`, `parseStatement`, and `generateSummaryLine` as call sites needing per-user provider resolution. It predates two features that also call `GoogleGenerativeAI` directly: `src/split/extraction.ts`'s `extractReceipt`, `src/split/assignment.ts`'s `parseSplitInstructions`, and this session's `src/bot/handlers/voice.ts`'s `transcribeVoice`. Since this plan removes the global `GOOGLE_API_KEY` env var entirely, leaving these three referencing `config.GOOGLE_API_KEY` would be a compile error, not just a stale call site. Tasks 16 and 21 migrate them too.

**Interface decision found necessary during planning:** the spec's sketch of `LLMProvider.generateText({ systemInstruction, prompt: string, timeoutMs })` only supports plain-text prompts, but three of the seven real call sites are multimodal (PDF statement, receipt photo, voice audio — all use Gemini's `inlineData` parts today). Task 5 below defines `ContentPart = { text: string } | { inlineData: { mimeType: string; data: string } }` and `generateText({ systemInstruction, contents: ContentPart[], timeoutMs })` so every call site — text and multimodal alike — routes through the same interface.

---

### Task 1: Schema — `users` table, `user_id` everywhere, drop `user_config`

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/config/currencies.ts:20-21` (stale `user_config` comment)
- Create: two migration files via `npm run db:generate`, run twice — `src/db/migrations/000X_<generated-name>.sql` (adds `users` + all five `user_id` columns) and `src/db/migrations/000Y_<generated-name>.sql` (drops `user_config`) — see the two-pass note below

**Interfaces:**
- Produces: `users` Drizzle table (columns: `id`, `telegram_chat_id`, `status`, `is_admin`, `llm_provider`, `llm_api_key_encrypted`, `webhook_api_key`, `created_at`, `updated_at`); `user_id` column added to `transactions`, `holdings`, `budgets`, `budget_alerts`, `recurring_transactions`.

This task is split into two schema-then-generate passes on purpose (see Global Constraints' second verified drizzle-kit quirk) — **do not** add `users` and remove `user_config` in the same `db:generate` invocation, or drizzle-kit hard-fails demanding an interactive TTY prompt that doesn't exist in an automated shell.

- [ ] **Step 1: Add the `users` table and `user_id` columns to `src/db/schema.ts` — leave `user_config` in place for now**

Add the `users` table **before** `transactions` (so the `() => users.id` reference resolves cleanly the same way `budget_alerts` already references `budgets`), and add a `user_id` column to each of the five existing tables. Leave the existing `user_config` table definition and the `primaryKey` import exactly as they are — they come out in Step 4, after the first migration is generated.

```typescript
// Users table
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  telegram_chat_id: text('telegram_chat_id').notNull().unique(),
  status: text('status').notNull(), // 'onboarding' | 'pending_approval' | 'approved'
  is_admin: integer('is_admin').notNull().default(0),
  llm_provider: text('llm_provider'), // 'gemini' for now; widened in a later slice
  llm_api_key_encrypted: text('llm_api_key_encrypted'),
  webhook_api_key: text('webhook_api_key').unique(),
  created_at: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updated_at: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// Transactions table
export const transactions = sqliteTable('transactions', {
  id: text('id').primaryKey(),
  user_id: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  amount: integer('amount').notNull(), // in cents
  currency: text('currency').notNull(),
  amount_sgd: integer('amount_sgd').notNull(), // normalized to SGD in cents
  merchant: text('merchant').notNull(),
  category: text('category').notNull(),
  source: text('source').notNull(),
  card_name: text('card_name').notNull(),
  note: text('note'),
  created_at: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updated_at: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// Holdings (portfolio) table
export const holdings = sqliteTable('holdings', {
  id: text('id').primaryKey(),
  user_id: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  symbol: text('symbol').notNull(),
  name: text('name').notNull(),
  asset_class: text('asset_class').notNull(),
  quantity: real('quantity').notNull(),
  currency: text('currency').notNull(),
  market: text('market').notNull(),
  broker: text('broker'),
  cost_basis: integer('cost_basis'),
  created_at: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updated_at: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// Budgets table
export const budgets = sqliteTable('budgets', {
  id: text('id').primaryKey(),
  user_id: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  category: text('category').notNull(),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  amount_sgd: integer('amount_sgd').notNull(),
  period: text('period').notNull(),
  created_at: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updated_at: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// Budget alert dedup table
export const budget_alerts = sqliteTable('budget_alerts', {
  id: text('id').primaryKey(),
  user_id: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  budget_id: text('budget_id')
    .notNull()
    .references(() => budgets.id, { onDelete: 'cascade' }),
  threshold: integer('threshold').notNull(),
  month: text('month').notNull(),
  sent_at: integer('sent_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// Recurring transactions table
export const recurring_transactions = sqliteTable('recurring_transactions', {
  id: text('id').primaryKey(),
  user_id: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  merchant: text('merchant').notNull(),
  category: text('category').notNull(),
  day_of_month: integer('day_of_month').notNull(),
  is_active: integer('is_active').notNull().default(1),
  created_at: integer('created_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updated_at: integer('updated_at')
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});
```

Delete the entire `user_config` table export at the bottom of the file. The `primaryKey` import becomes unused once it's gone — remove it from the `drizzle-orm/sqlite-core` import list too.

- [ ] **Step 2: Generate the first migration (pure addition)**

Run: `npm run db:generate`

Expected: this runs non-interactively (verified — a pure addition with no table removed in the same pass never hits the rename-ambiguity prompt) and produces a new file `src/db/migrations/000X_<random-name>.sql` (drizzle-kit names it randomly, e.g. `0004_dazzling_marvex.sql`) containing a `CREATE TABLE users (...)`, two `CREATE UNIQUE INDEX` statements, and five `ALTER TABLE ... ADD user_id ...` statements (one per existing table) — no `DROP TABLE` statement yet, since `user_config` is still in the schema.

- [ ] **Step 3: Fix the missing `ON DELETE CASCADE` (verified drizzle-kit gap — see Global Constraints)**

Open the migration file Step 2 generated. It will contain five lines shaped like:

```sql
ALTER TABLE `transactions` ADD `user_id` text NOT NULL REFERENCES users(id);
```

Manually append ` ON DELETE CASCADE` before the semicolon on **all five** `ALTER TABLE ... ADD user_id` lines (`transactions`, `holdings`, `budgets`, `budget_alerts`, `recurring_transactions`), e.g.:

```sql
ALTER TABLE `transactions` ADD `user_id` text NOT NULL REFERENCES users(id) ON DELETE CASCADE;
```

Leave the `CREATE TABLE users (...)` and the two `CREATE UNIQUE INDEX` statements exactly as generated.

- [ ] **Step 4: Remove `user_config` from `src/db/schema.ts`, then generate the second migration (solo drop)**

Now delete the `user_config` table export from `src/db/schema.ts` entirely, and remove the now-unused `primaryKey` import from the `drizzle-orm/sqlite-core` import list.

Run: `npm run db:generate` again.

Expected: this runs non-interactively (verified — a solo removal with nothing added in the same pass never hits the rename-ambiguity prompt either) and produces a **second** new migration file containing exactly one statement: `DROP TABLE \`user_config\`;`.

- [ ] **Step 5: Fix the stale `user_config` comment**

In `src/config/currencies.ts:20-21`, change:

```typescript
// Card to currency mapping
// This can be overridden by user configuration in user_config table
```

to:

```typescript
// Card to currency mapping
```

- [ ] **Step 6: Verify both migrations apply cleanly, and that no further changes are pending**

Run: `rm -f ./data/test-schema-check.db && DATABASE_URL=./data/test-schema-check.db npx tsx src/db/migrate.ts && rm -f ./data/test-schema-check.db`

Expected: `Migrations completed successfully!` with no errors (both the Step 2 and Step 4 migration files apply in order).

Then run `npm run db:generate` one more time. Expected: `No schema changes, nothing to migrate` (or equivalent) — confirming the two migrations together fully match `schema.ts` and no third migration is silently needed.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts src/db/migrations/ src/config/currencies.ts
git commit -m "feat(db): add users table, user_id FKs on every table, drop user_config"
```

Both migration files (the addition and the drop) go into this one commit — they're one logical schema change split across two `db:generate` calls only because of the tooling limitation above, not two separate pieces of work.

---

### Task 2: Config — add `ENCRYPTION_KEY` and `ADMIN_CHAT_ID`

`GOOGLE_API_KEY`, `WEBHOOK_API_KEY`, and `TELEGRAM_AUTHORIZED_CHAT_ID` are **not** removed yet — later tasks still reference them until every call site is migrated (see Global Constraints' "red window" note). This task only adds the two new variables.

**Files:**
- Modify: `src/config/env.ts`
- Create: `src/config/env.test.ts`
- Modify: `package.json` (add `src/config/env.test.ts` to the `test` script)

**Interfaces:**
- Produces: `config.ENCRYPTION_KEY: string`, `config.ADMIN_CHAT_ID: string | undefined`

- [ ] **Step 0: Add a real `ENCRYPTION_KEY` to the local `.env` file**

Once `ENCRYPTION_KEY` becomes required (Step 4 below), `src/config/env.ts`'s module-level `loadConfig()` call throws immediately for *every* test file that transitively imports `config` — which is nearly all of them — unless the real `.env` file (loaded via `dotenv.config()`) has a valid value. `env.test.ts` itself is unaffected (it fully overrides `process.env` before requiring the module), but every other test file relies on the real `.env`.

Run: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

Append its output to `.env` (not `.env.example`, which stays a placeholder) as a new line:

```
ENCRYPTION_KEY=<the generated 64-character hex value>
```

Also add a documented placeholder to `.env.example`, right after the `GOOGLE_API_KEY` block:

```
# Encrypts each user's BYOK LLM API key at rest (AES-256-GCM). Generate one with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
ENCRYPTION_KEY=
```

- [ ] **Step 1: Write the failing test**

Create `src/config/env.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

const VALID_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd'; // 64 hex chars
const BASE_ENV = {
  DATABASE_URL: './data/test-env-config.db',
  GOOGLE_API_KEY: 'unused-in-this-file',
  ENCRYPTION_KEY: VALID_KEY,
};

function loadConfigWith(env: Record<string, string | undefined>): unknown {
  const originalEnv = { ...process.env };
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  Object.assign(process.env, env);

  try {
    delete require.cache[require.resolve('./env')];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./env').config;
  } finally {
    Object.keys(process.env).forEach((key) => delete process.env[key]);
    Object.assign(process.env, originalEnv);
  }
}

test('loadConfig accepts a valid 64-character hex ENCRYPTION_KEY', () => {
  const config = loadConfigWith(BASE_ENV) as { ENCRYPTION_KEY: string };
  assert.equal(config.ENCRYPTION_KEY, VALID_KEY);
});

test('loadConfig rejects an ENCRYPTION_KEY that is not 64 hex characters', () => {
  assert.throws(() => loadConfigWith({ ...BASE_ENV, ENCRYPTION_KEY: 'too-short' }));
});

test('loadConfig succeeds without ADMIN_CHAT_ID when TELEGRAM_BOT_TOKEN is unset', () => {
  const config = loadConfigWith(BASE_ENV) as { ADMIN_CHAT_ID?: string };
  assert.equal(config.ADMIN_CHAT_ID, undefined);
});

test('loadConfig rejects a missing ADMIN_CHAT_ID when TELEGRAM_BOT_TOKEN is set', () => {
  assert.throws(() => loadConfigWith({ ...BASE_ENV, TELEGRAM_BOT_TOKEN: 'fake-token' }));
});

test('loadConfig accepts ADMIN_CHAT_ID when TELEGRAM_BOT_TOKEN is set', () => {
  const config = loadConfigWith({ ...BASE_ENV, TELEGRAM_BOT_TOKEN: 'fake-token', ADMIN_CHAT_ID: '12345' }) as {
    ADMIN_CHAT_ID?: string;
  };
  assert.equal(config.ADMIN_CHAT_ID, '12345');
});
```

Note: this test manipulates `process.env` and `require.cache` directly (rather than the `import`-based dynamic-reload pattern other test files use) because `src/config/env.ts` runs its `loadConfig()` at module-load time as a side effect (`export const config = loadConfig()`) — there's no factory function to call repeatedly with different inputs otherwise. This is the only test file in the repo that needs this pattern; don't copy it elsewhere.

- [ ] **Step 2: Add `src/config/env.test.ts` to `package.json`'s test script**

In `package.json`, add `src/config/env.test.ts` to the space-separated file list in the `"test"` script (position doesn't matter — e.g. right after `src/bot/ai.test.ts`).

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx tsx --test src/config/env.test.ts`
Expected: FAIL — `ENCRYPTION_KEY` and `ADMIN_CHAT_ID` don't exist on the schema yet, so `loadConfigWith(BASE_ENV)` throws for every test (including the ones expecting success).

- [ ] **Step 4: Update `src/config/env.ts`**

Replace the `envSchema` definition:

```typescript
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DATABASE_URL: z.string().default('./data/pluto.db'),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_AUTHORIZED_CHAT_ID: z.string().optional(),
    ADMIN_CHAT_ID: z.string().optional(),
    GOOGLE_API_KEY: z
      .string()
      .min(1, 'GOOGLE_API_KEY is required — Pluto AI classifies every message with Gemini and has no rule-based fallback'),
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, 'ENCRYPTION_KEY must be a 64-character hex string (32 bytes) for AES-256-GCM'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    PORT: z.string().default('3000'),
    WEBHOOK_API_KEY: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.TELEGRAM_BOT_TOKEN && !val.ADMIN_CHAT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADMIN_CHAT_ID'],
        message:
          'ADMIN_CHAT_ID is required when TELEGRAM_BOT_TOKEN is set — without a designated admin, no user (including the first) can be approved.',
      });
    }
  });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx --test src/config/env.test.ts`
Expected: PASS (5/5).

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts package.json .env.example
git commit -m "feat(config): add ENCRYPTION_KEY and conditionally-required ADMIN_CHAT_ID"
```

(`.env` itself is gitignored — its new `ENCRYPTION_KEY` line from Step 0 stays local.)

---

### Task 3: `src/users/crypto.ts` — AES-256-GCM encrypt/decrypt

**Files:**
- Create: `src/users/crypto.ts`
- Create: `src/users/crypto.test.ts`
- Modify: `package.json` (add `src/users/crypto.test.ts`)

**Interfaces:**
- Produces: `encrypt(plaintext: string): string`, `decrypt(ciphertext: string): string`

- [ ] **Step 1: Write the failing tests**

Create `src/users/crypto.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

test('encrypt then decrypt returns the original plaintext', async () => {
  const { encrypt, decrypt } = await import('./crypto');
  const plaintext = 'AIzaSyFakeGeminiKeyForTesting1234567890';

  const ciphertext = encrypt(plaintext);
  assert.notEqual(ciphertext, plaintext);

  const decrypted = decrypt(ciphertext);
  assert.equal(decrypted, plaintext);
});

test('encrypt produces a different ciphertext each time for the same plaintext', async () => {
  const { encrypt } = await import('./crypto');
  const a = encrypt('same-plaintext');
  const b = encrypt('same-plaintext');
  assert.notEqual(a, b);
});

test('decrypt throws on a malformed ciphertext', async () => {
  const { decrypt } = await import('./crypto');
  assert.throws(() => decrypt('not-a-real-ciphertext'));
});

test('decrypt throws when the ciphertext has been tampered with', async () => {
  const { encrypt, decrypt } = await import('./crypto');
  const ciphertext = encrypt('some-api-key');
  const [iv, authTag, data] = ciphertext.split(':');
  const tampered = `${iv}:${authTag}:${data.slice(0, -2)}ff`;
  assert.throws(() => decrypt(tampered));
});
```

- [ ] **Step 2: Add `src/users/crypto.test.ts` to `package.json`'s test script**

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx tsx --test src/users/crypto.test.ts`
Expected: FAIL — `./crypto` doesn't exist yet.

- [ ] **Step 4: Write the implementation**

Create `src/users/crypto.ts`:

```typescript
/**
 * AES-256-GCM encrypt/decrypt for BYOK LLM API keys at rest.
 * Ciphertext format: "<iv-hex>:<authTag-hex>:<data-hex>".
 */

import crypto from 'crypto';
import { config } from '../config';

const ALGORITHM = 'aes-256-gcm';

function getKey(): Buffer {
  return Buffer.from(config.ENCRYPTION_KEY, 'hex');
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted value');
  }
  const [ivHex, authTagHex, dataHex] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test src/users/crypto.test.ts`
Expected: PASS (4/4).

- [ ] **Step 6: Commit**

```bash
git add src/users/crypto.ts src/users/crypto.test.ts package.json
git commit -m "feat(users): add AES-256-GCM encrypt/decrypt for BYOK API keys"
```

---

### Task 4: `src/users/service.ts` — user CRUD

**Files:**
- Create: `src/users/types.ts`
- Create: `src/users/service.ts`
- Create: `src/users/service.test.ts`
- Modify: `package.json` (add `src/users/service.test.ts`)

**Interfaces:**
- Consumes: `db`, `users` from `../db` and `../db/schema` (Task 1)
- Produces: `User`, `UserStatus`, `LLMProviderName` types; `createUser(telegramChatId: string): Promise<User>`; `setProvider(userId: string, provider: LLMProviderName): Promise<User>`; `completeSetup(userId: string, encryptedApiKey: string, isAdmin: boolean): Promise<User>`; `approve(userId: string): Promise<User>`; `reject(userId: string): Promise<void>`; `findByChatId(telegramChatId: string): Promise<User | null>`; `findByWebhookKey(webhookApiKey: string): Promise<User | null>`; `findById(userId: string): Promise<User | null>`; `listApproved(): Promise<User[]>`

- [ ] **Step 1: Write `src/users/types.ts`**

```typescript
/**
 * Users module types
 */

export type UserStatus = 'onboarding' | 'pending_approval' | 'approved';

// One provider today ('gemini') — widened in a later slice.
export type LLMProviderName = 'gemini';

export interface User {
  id: string;
  telegram_chat_id: string;
  status: UserStatus;
  is_admin: boolean;
  llm_provider: LLMProviderName | null;
  llm_api_key_encrypted: string | null;
  webhook_api_key: string | null;
  created_at: Date;
  updated_at: Date;
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/users/service.test.ts`:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-users-service.db';

const testDbPath = path.resolve('./data/test-users-service.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
});

test('createUser creates an onboarding row with no provider or admin flag', async () => {
  const { createUser } = await import('./service');
  const user = await createUser('chat-1');

  assert.equal(user.telegram_chat_id, 'chat-1');
  assert.equal(user.status, 'onboarding');
  assert.equal(user.is_admin, false);
  assert.equal(user.llm_provider, null);
  assert.equal(user.llm_api_key_encrypted, null);
  assert.equal(user.webhook_api_key, null);
});

test('findByChatId returns null when no user exists for that chat', async () => {
  const { findByChatId } = await import('./service');
  const result = await findByChatId('nonexistent-chat');
  assert.equal(result, null);
});

test('findByChatId returns the created user', async () => {
  const { createUser, findByChatId } = await import('./service');
  await createUser('chat-2');

  const found = await findByChatId('chat-2');
  assert.ok(found);
  assert.equal(found!.telegram_chat_id, 'chat-2');
});

test('setProvider records the chosen provider and (re)sets status to onboarding', async () => {
  const { createUser, setProvider, approve } = await import('./service');
  const user = await createUser('chat-3');
  await approve(user.id); // simulate an already-approved user restarting setup

  const updated = await setProvider(user.id, 'gemini');
  assert.equal(updated.llm_provider, 'gemini');
  assert.equal(updated.status, 'onboarding');
});

test('completeSetup for a first-time non-admin user goes to pending_approval and generates a webhook key', async () => {
  const { createUser, setProvider, completeSetup } = await import('./service');
  const user = await createUser('chat-4');
  await setProvider(user.id, 'gemini');

  const completed = await completeSetup(user.id, 'encrypted-key-value', false);
  assert.equal(completed.status, 'pending_approval');
  assert.equal(completed.is_admin, false);
  assert.equal(completed.llm_api_key_encrypted, 'encrypted-key-value');
  assert.ok(completed.webhook_api_key);
});

test('completeSetup for the admin chat auto-approves', async () => {
  const { createUser, setProvider, completeSetup } = await import('./service');
  const user = await createUser('chat-5-admin');
  await setProvider(user.id, 'gemini');

  const completed = await completeSetup(user.id, 'encrypted-key-value', true);
  assert.equal(completed.status, 'approved');
  assert.equal(completed.is_admin, true);
});

test('completeSetup on an already-completed user (key rotation) stays approved and reuses the webhook key', async () => {
  const { createUser, setProvider, completeSetup, approve } = await import('./service');
  const user = await createUser('chat-6');
  await setProvider(user.id, 'gemini');
  const firstCompletion = await completeSetup(user.id, 'first-key', false);
  await approve(user.id); // admin approves the pending user

  await setProvider(user.id, 'gemini'); // re-running /setup
  const rotated = await completeSetup(user.id, 'second-key', false);

  assert.equal(rotated.status, 'approved'); // skipped pending_approval on rotation
  assert.equal(rotated.llm_api_key_encrypted, 'second-key');
  assert.equal(rotated.webhook_api_key, firstCompletion.webhook_api_key);
});

test('approve sets status to approved', async () => {
  const { createUser, approve } = await import('./service');
  const user = await createUser('chat-7');
  const approved = await approve(user.id);
  assert.equal(approved.status, 'approved');
});

test('reject deletes the user row', async () => {
  const { createUser, reject, findByChatId } = await import('./service');
  await createUser('chat-8');
  const user = await findByChatId('chat-8');
  await reject(user!.id);

  const afterReject = await findByChatId('chat-8');
  assert.equal(afterReject, null);
});

test('findByWebhookKey returns the matching user', async () => {
  const { createUser, setProvider, completeSetup, findByWebhookKey } = await import('./service');
  const user = await createUser('chat-9');
  await setProvider(user.id, 'gemini');
  const completed = await completeSetup(user.id, 'some-key', false);

  const found = await findByWebhookKey(completed.webhook_api_key!);
  assert.ok(found);
  assert.equal(found!.id, user.id);
});

test('findById returns null for a nonexistent id', async () => {
  const { findById } = await import('./service');
  const result = await findById('does-not-exist');
  assert.equal(result, null);
});

test('listApproved returns only approved users', async () => {
  const { createUser, approve, listApproved } = await import('./service');
  const approvedUser = await createUser('chat-10-approved');
  await approve(approvedUser.id);
  await createUser('chat-11-onboarding');

  const approvedList = await listApproved();
  assert.ok(approvedList.some((u) => u.telegram_chat_id === 'chat-10-approved'));
  assert.ok(!approvedList.some((u) => u.telegram_chat_id === 'chat-11-onboarding'));
});
```

- [ ] **Step 3: Add `src/users/service.test.ts` to `package.json`'s test script**

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx tsx --test src/users/service.test.ts`
Expected: FAIL — `./service` doesn't exist yet.

- [ ] **Step 5: Write `src/users/service.ts`**

```typescript
/**
 * User CRUD (Drizzle-backed).
 */

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { LLMProviderName, User, UserStatus } from './types';

function mapUserRow(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    telegram_chat_id: row.telegram_chat_id,
    status: row.status as UserStatus,
    is_admin: Boolean(row.is_admin),
    llm_provider: (row.llm_provider as LLMProviderName | null) ?? null,
    llm_api_key_encrypted: row.llm_api_key_encrypted ?? null,
    webhook_api_key: row.webhook_api_key ?? null,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

export async function createUser(telegramChatId: string): Promise<User> {
  const now = Date.now();
  const [inserted] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      telegram_chat_id: telegramChatId,
      status: 'onboarding',
      is_admin: 0,
      created_at: now,
      updated_at: now,
    })
    .returning();
  return mapUserRow(inserted);
}

export async function setProvider(userId: string, provider: LLMProviderName): Promise<User> {
  const [updated] = await db
    .update(users)
    .set({ llm_provider: provider, status: 'onboarding', updated_at: Date.now() })
    .where(eq(users.id, userId))
    .returning();
  if (!updated) {
    throw new Error(`No user found with id ${userId}`);
  }
  return mapUserRow(updated);
}

/**
 * Stores the validated, encrypted API key. Auto-approves when `isAdmin` is
 * true (ADMIN_CHAT_ID's first setup); otherwise a first-time completion goes
 * to 'pending_approval', while a returning user (one who already had an
 * encrypted key — i.e. rotating their key) goes straight back to 'approved',
 * reusing their existing webhook_api_key instead of generating a new one.
 */
export async function completeSetup(userId: string, encryptedApiKey: string, isAdmin: boolean): Promise<User> {
  const existing = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!existing) {
    throw new Error(`No user found with id ${userId}`);
  }

  const isRotation = existing.llm_api_key_encrypted !== null;
  const webhookApiKey = existing.webhook_api_key ?? randomUUID();
  const status: UserStatus = isRotation || isAdmin ? 'approved' : 'pending_approval';

  const [updated] = await db
    .update(users)
    .set({
      llm_api_key_encrypted: encryptedApiKey,
      webhook_api_key: webhookApiKey,
      status,
      is_admin: isAdmin ? 1 : existing.is_admin,
      updated_at: Date.now(),
    })
    .where(eq(users.id, userId))
    .returning();

  return mapUserRow(updated);
}

export async function approve(userId: string): Promise<User> {
  const [updated] = await db
    .update(users)
    .set({ status: 'approved', updated_at: Date.now() })
    .where(eq(users.id, userId))
    .returning();
  if (!updated) {
    throw new Error(`No user found with id ${userId}`);
  }
  return mapUserRow(updated);
}

export async function reject(userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}

export async function findByChatId(telegramChatId: string): Promise<User | null> {
  const row = await db.select().from(users).where(eq(users.telegram_chat_id, telegramChatId)).get();
  return row ? mapUserRow(row) : null;
}

export async function findByWebhookKey(webhookApiKey: string): Promise<User | null> {
  const row = await db.select().from(users).where(eq(users.webhook_api_key, webhookApiKey)).get();
  return row ? mapUserRow(row) : null;
}

export async function findById(userId: string): Promise<User | null> {
  const row = await db.select().from(users).where(eq(users.id, userId)).get();
  return row ? mapUserRow(row) : null;
}

export async function listApproved(): Promise<User[]> {
  const rows = await db.select().from(users).where(eq(users.status, 'approved'));
  return rows.map(mapUserRow);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx --test src/users/service.test.ts`
Expected: PASS (12/12).

- [ ] **Step 7: Commit**

```bash
git add src/users/types.ts src/users/service.ts src/users/service.test.ts package.json
git commit -m "feat(users): add user CRUD service (onboarding, approval, rotation)"
```

---

### Task 5: `src/llm/provider.ts` + `src/llm/gemini.ts` — the LLM provider abstraction

See "Interface decision found necessary during planning" above for why `contents: ContentPart[]` replaces the spec's `prompt: string`.

**Files:**
- Create: `src/llm/provider.ts`
- Create: `src/llm/gemini.ts`
- Create: `src/llm/gemini.test.ts`
- Modify: `package.json` (add `src/llm/gemini.test.ts`)

**Interfaces:**
- Consumes: `decrypt` from `../users/crypto` (Task 3), `User` from `../users/types` (Task 4)
- Produces: `ContentPart` type, `LLMProvider` interface (`generateText(params: { systemInstruction: string; contents: ContentPart[]; timeoutMs?: number }): Promise<string>`), `getProviderForUser(user: User): LLMProvider`, `GeminiProvider` class

Note the file split: `provider.ts` owns the interface/types and `getProviderForUser`; `gemini.ts` owns the one concrete implementation. `gemini.ts` imports `ContentPart`/`LLMProvider` from `provider.ts` as **type-only** imports (`import type { ... }`) so there's no runtime circular dependency with `provider.ts` importing `GeminiProvider` from `gemini.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/llm/gemini.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';

function geminiRestResponse(text: string): Response {
  const body = JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

test('generateText returns the text from a successful call', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => geminiRestResponse('Hello from Gemini')) as typeof fetch;

  try {
    const { GeminiProvider } = await import('./gemini');
    const provider = new GeminiProvider('fake-api-key');
    const result = await provider.generateText({
      systemInstruction: 'You are a test.',
      contents: [{ text: 'Say hello' }],
    });
    assert.equal(result, 'Hello from Gemini');
  } finally {
    global.fetch = originalFetch;
  }
});

test('generateText sends multimodal inlineData parts through to the request body', async () => {
  const originalFetch = global.fetch;
  let capturedBody: string | undefined;
  global.fetch = (async (_input, init) => {
    capturedBody = init?.body as string;
    return geminiRestResponse('transcribed text');
  }) as typeof fetch;

  try {
    const { GeminiProvider } = await import('./gemini');
    const provider = new GeminiProvider('fake-api-key');
    await provider.generateText({
      systemInstruction: 'Transcribe this.',
      contents: [
        { inlineData: { mimeType: 'audio/ogg', data: Buffer.from('fake audio').toString('base64') } },
        { text: 'Transcribe.' },
      ],
    });

    assert.ok(capturedBody);
    const parsed = JSON.parse(capturedBody!);
    assert.ok(parsed.contents[0].parts[0].inlineData);
    assert.equal(parsed.contents[0].parts[0].inlineData.mimeType, 'audio/ogg');
  } finally {
    global.fetch = originalFetch;
  }
});

test('generateText propagates a network failure', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { GeminiProvider } = await import('./gemini');
    const provider = new GeminiProvider('fake-api-key');
    await assert.rejects(() =>
      provider.generateText({ systemInstruction: 'x', contents: [{ text: 'y' }] }),
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('generateText rejects once the call exceeds its timeoutMs', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => new Promise(() => {})) as unknown as typeof fetch; // never resolves

  try {
    const { GeminiProvider } = await import('./gemini');
    const provider = new GeminiProvider('fake-api-key');
    await assert.rejects(
      () => provider.generateText({ systemInstruction: 'x', contents: [{ text: 'y' }], timeoutMs: 50 }),
      /timed out/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});
```

Also add a `provider.test.ts` section to the same file (kept in `gemini.test.ts` rather than a separate file, since `getProviderForUser` is a thin dispatcher with no independent runtime behavior worth its own test file yet — it gets a second real implementation to dispatch between in a later slice):

```typescript
test('getProviderForUser returns a GeminiProvider for a user configured with gemini', async () => {
  const { getProviderForUser } = await import('./provider');
  const { GeminiProvider } = await import('./gemini');
  const { encrypt } = await import('../users/crypto');

  const provider = getProviderForUser({
    id: 'u1',
    telegram_chat_id: 'chat-1',
    status: 'approved',
    is_admin: false,
    llm_provider: 'gemini',
    llm_api_key_encrypted: encrypt('fake-key'),
    webhook_api_key: 'wh-1',
    created_at: new Date(),
    updated_at: new Date(),
  });

  assert.ok(provider instanceof GeminiProvider);
});

test('getProviderForUser throws when the user has no provider configured yet', async () => {
  const { getProviderForUser } = await import('./provider');

  assert.throws(() =>
    getProviderForUser({
      id: 'u2',
      telegram_chat_id: 'chat-2',
      status: 'onboarding',
      is_admin: false,
      llm_provider: null,
      llm_api_key_encrypted: null,
      webhook_api_key: null,
      created_at: new Date(),
      updated_at: new Date(),
    }),
  );
});
```

(Add the `import assert from 'node:assert/strict';` and `import test from 'node:test';` lines already present at the top of the file cover both blocks — no separate imports needed.)

- [ ] **Step 2: Add `src/llm/gemini.test.ts` to `package.json`'s test script**

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx tsx --test src/llm/gemini.test.ts`
Expected: FAIL — neither `./gemini` nor `./provider` exist yet.

- [ ] **Step 4: Write `src/llm/provider.ts`**

```typescript
/**
 * LLM provider abstraction. One implementation (Gemini) today — this
 * interface is what lets a later slice add OpenAI/Anthropic without
 * touching any call site again.
 */

import { decrypt } from '../users/crypto';
import { User } from '../users/types';
import { GeminiProvider } from './gemini';

export type ContentPart = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface LLMProvider {
  generateText(params: { systemInstruction: string; contents: ContentPart[]; timeoutMs?: number }): Promise<string>;
}

export function getProviderForUser(user: User): LLMProvider {
  if (!user.llm_provider || !user.llm_api_key_encrypted) {
    throw new Error(`User ${user.id} has no configured LLM provider — they must complete /setup first`);
  }

  const apiKey = decrypt(user.llm_api_key_encrypted);

  switch (user.llm_provider) {
    case 'gemini':
      return new GeminiProvider(apiKey);
    default:
      throw new Error(`Unsupported LLM provider "${user.llm_provider}"`);
  }
}
```

- [ ] **Step 5: Write `src/llm/gemini.ts`**

```typescript
/**
 * Gemini implementation of LLMProvider. Model id is pinned the same way
 * every other Gemini call site in this codebase pins it.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ContentPart, LLMProvider } from './provider';

const DEFAULT_TIMEOUT_MS = 15000;

export class GeminiProvider implements LLMProvider {
  constructor(private readonly apiKey: string) {}

  async generateText(params: {
    systemInstruction: string;
    contents: ContentPart[];
    timeoutMs?: number;
  }): Promise<string> {
    const genAI = new GoogleGenerativeAI(this.apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      systemInstruction: params.systemInstruction,
    });

    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Gemini call timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    const result = await Promise.race([model.generateContent(params.contents), timeoutPromise]);
    return result.response.text();
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx --test src/llm/gemini.test.ts`
Expected: PASS (6/6).

- [ ] **Step 7: Commit**

```bash
git add src/llm/ package.json
git commit -m "feat(llm): add LLMProvider abstraction with a Gemini implementation"
```

---

### Task 6: Migrate `expense/service.ts`'s transaction functions onto Drizzle + `userId`

Migrates `logExpense`, `undoLastTransaction`, `correctLastTransaction`, `getSpendingSummary`, `getSpendingByCategory`, `getTopExpenses`, `compareSpending`, `exportCSV`. The recurring-transaction functions in the same file (`createRecurring`, `pauseRecurring`, `removeRecurring`, `listRecurring`, `fireRecurringForToday`, `getRecurringFiredToday`) are left untouched (still raw SQL, no `userId`) until Task 7 — this task's code sample shows the complete file with only the transaction functions migrated.

`inferCategory` is **not yet** updated to take a `userId` — that happens in Task 13, which will also update this file's calls to it. For now `correctLastTransaction`'s category branch keeps calling `inferCategory({ merchant, note, amount })` with the pre-existing signature.

**Files:**
- Modify: `src/expense/service.ts`
- Modify: `src/expense/expense.test.ts`

**Interfaces:**
- Consumes: `db` from `../db`, `transactions` from `../db/schema`
- Produces: every transaction-related export above now takes a leading `userId: string` parameter (signatures otherwise unchanged from before)

- [ ] **Step 1: Update `src/expense/expense.test.ts` first (RED)**

Replace the whole file:

```typescript
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stubGeminiCategorization } from '../testing/geminiStub';

process.env.DATABASE_URL = './data/test-plutus.db';

const testDbPath = path.resolve('./data/test-plutus.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let restoreGeminiStub: () => void;
let userId: string;

before(async () => {
  restoreGeminiStub = stubGeminiCategorization();
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
  const { createUser } = await import('../users/service');
  const user = await createUser('test-expense-chat');
  userId = user.id;
});

after(() => {
  restoreGeminiStub();
});

test('logExpense stores SGD-normalized value and detects local categories', async () => {
  const { logExpense, getSpendingSummary } = await import('./index');
  const kopi = await logExpense(userId, {
    amount: 450,
    currency: 'MYR',
    merchant: 'Kopi tiam',
    cardName: 'Maybank',
    note: 'kopi and toast',
    source: 'text',
  });

  assert.equal(kopi.category, 'Food');
  assert.equal(kopi.currency, 'MYR');
  assert.ok(kopi.amount_sgd > 0);

  const grab = await logExpense(userId, {
    amount: 1200,
    currency: 'SGD',
    merchant: 'Grab ride',
    cardName: 'DBS Visa',
    note: 'grab home',
    source: 'apple_pay',
  });

  assert.equal(grab.category, 'Transport');
  assert.ok(grab.amount_sgd > 0);

  const summary = await getSpendingSummary(userId, 'month');
  assert.ok(summary.total > 0);
  assert.ok(summary.byCategory.Food >= 0 || summary.byCategory.Transport >= 0);
});

test('undoLastTransaction removes the most recent entry', async () => {
  const { getSpendingSummary, undoLastTransaction } = await import('./index');
  const before = await getSpendingSummary(userId, 'month');
  const undone = await undoLastTransaction(userId);

  assert.ok(undone);
  const after = await getSpendingSummary(userId, 'month');
  assert.ok(after.total <= before.total);
});

test('undoLastTransaction only ever affects the calling user', async () => {
  const { createUser } = await import('../users/service');
  const { logExpense, undoLastTransaction, getSpendingSummary } = await import('./index');
  const otherUser = await createUser('test-expense-other-chat');

  await logExpense(otherUser.id, { amount: 5, currency: 'SGD', merchant: 'Other user item', source: 'text' });
  const undone = await undoLastTransaction(userId); // userId has no transactions left after the previous test's undo

  assert.equal(undone, null);
  const otherSummary = await getSpendingSummary(otherUser.id, 'month');
  assert.equal(otherSummary.count, 1); // untouched
});

test('correctLastTransaction updates the calling user\'s most recent transaction', async () => {
  const { logExpense, correctLastTransaction } = await import('./index');
  await logExpense(userId, { amount: 20, currency: 'SGD', merchant: 'Original merchant', source: 'text' });

  const corrected = await correctLastTransaction(userId, 'merchant', 'Corrected merchant');
  assert.ok(corrected);
  assert.equal(corrected!.merchant, 'Corrected merchant');
});

test('getSpendingSummary tracks a per-category transaction count', async () => {
  const { logExpense, getSpendingSummary } = await import('./index');
  const before = await getSpendingSummary(userId, 'today');
  const beforeCount = before.byCategoryCount.Entertainment ?? 0;

  await logExpense(userId, { amount: 10, currency: 'SGD', merchant: 'Netflix subscription', source: 'text' });
  await logExpense(userId, { amount: 10, currency: 'SGD', merchant: 'Netflix subscription', source: 'text' });

  const after = await getSpendingSummary(userId, 'today');
  assert.equal(after.byCategoryCount.Entertainment, beforeCount + 2);

  const totalFromCounts = Object.values(after.byCategoryCount).reduce((sum, n) => sum + n, 0);
  assert.equal(totalFromCounts, after.count);
});

test('exportCSV writes a per-user file scoped to that user\'s transactions', async () => {
  const { exportCSV } = await import('./index');
  const filePath = await exportCSV(userId, new Date().getFullYear());
  assert.ok(fs.existsSync(filePath));
  assert.match(filePath, new RegExp(userId));
});
```

(The recurring-transaction tests from the original file — `'recurring transactions can be fired for today'` and `'getRecurringFiredToday reports already-fired recurring transactions...'` — move to Task 7, which migrates those functions.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/expense/expense.test.ts`
Expected: FAIL — `logExpense` etc. don't accept a `userId` first argument yet.

- [ ] **Step 3: Rewrite `src/expense/service.ts`**

Replace the whole file:

```typescript
/**
 * Transaction and recurring expense service.
 */

import { randomUUID } from 'crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { and, desc, eq, gte, lt } from 'drizzle-orm';

import { config, toSGD } from '../config';
import { db } from '../db';
import { transactions } from '../db/schema';
import { Category, Currency, Transaction } from '../types';
import { inferCategory } from './categorizer';
import { resolveCurrency } from './currency-resolver';
import {
  Comparison,
  ExpenseInput,
  RecurringInput,
  SpendingPeriod,
  SpendingSummary,
} from './types';

function ensureDataDirectory(): void {
  const dataDir = path.dirname(config.DATABASE_URL);
  if (dataDir && dataDir !== '.') {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function getSQLiteDb(): Database.Database {
  ensureDataDirectory();
  const sqliteDb = new Database(config.DATABASE_URL);
  return sqliteDb;
}

function centsFromAmount(amount: number): number {
  return Math.max(0, Math.round(amount * 100));
}

function startOfPeriod(period: SpendingPeriod): number {
  const now = new Date();
  const start = new Date(now);

  if (period === 'today') {
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }

  if (period === 'week') {
    start.setDate(now.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }

  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

function mapTransactionRow(row: typeof transactions.$inferSelect): Transaction {
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency as Currency,
    amount_sgd: row.amount_sgd,
    merchant: row.merchant,
    category: row.category as Category,
    source: row.source,
    card_name: row.card_name,
    note: row.note ?? undefined,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

export async function logExpense(userId: string, data: ExpenseInput): Promise<Transaction> {
  const normalizedCurrency = resolveCurrency({
    currency: data.currency,
    cardName: data.cardName,
    merchant: data.merchant,
    note: data.note,
  });

  const amountCents = centsFromAmount(data.amount);
  const merchant = (data.merchant ?? 'Unknown merchant').trim() || 'Unknown merchant';
  const category = await inferCategory({ merchant, note: data.note, amount: amountCents });
  const now = Date.now();
  const amountSgd = toSGD(amountCents, normalizedCurrency);

  const [inserted] = await db
    .insert(transactions)
    .values({
      id: randomUUID(),
      user_id: userId,
      amount: amountCents,
      currency: normalizedCurrency,
      amount_sgd: amountSgd,
      merchant,
      category,
      source: data.source ?? 'text',
      card_name: data.cardName ?? 'General',
      note: data.note ?? null,
      created_at: now,
      updated_at: now,
    })
    .returning();

  return mapTransactionRow(inserted);
}

export async function undoLastTransaction(userId: string): Promise<Transaction | null> {
  const row = await db
    .select()
    .from(transactions)
    .where(eq(transactions.user_id, userId))
    .orderBy(desc(transactions.created_at))
    .limit(1)
    .get();

  if (!row) {
    return null;
  }

  await db.delete(transactions).where(eq(transactions.id, row.id));
  return mapTransactionRow(row);
}

export async function getSpendingSummary(userId: string, period: SpendingPeriod): Promise<SpendingSummary> {
  const start = startOfPeriod(period);
  const rows = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.user_id, userId), gte(transactions.created_at, start)))
    .orderBy(desc(transactions.created_at));

  const byCategory: Record<string, number> = {};
  const byCategoryCount: Record<string, number> = {};
  let total = 0;

  for (const row of rows) {
    total += row.amount_sgd;
    byCategory[row.category] = (byCategory[row.category] ?? 0) + row.amount_sgd;
    byCategoryCount[row.category] = (byCategoryCount[row.category] ?? 0) + 1;
  }

  return {
    period,
    total,
    count: rows.length,
    byCategory,
    byCategoryCount,
    topExpenses: rows.slice(0, 5).map(mapTransactionRow),
  };
}

export async function getSpendingByCategory(
  userId: string,
  period: SpendingPeriod,
): Promise<{ category: string; total: number }[]> {
  const summary = await getSpendingSummary(userId, period);
  return Object.entries(summary.byCategory).map(([category, total]) => ({ category, total }));
}

export async function getTopExpenses(userId: string, period: SpendingPeriod, limit = 5): Promise<Transaction[]> {
  const start = startOfPeriod(period);
  const rows = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.user_id, userId), gte(transactions.created_at, start)))
    .orderBy(desc(transactions.created_at))
    .limit(limit);
  return rows.map(mapTransactionRow);
}

export async function compareSpending(
  userId: string,
  period1: SpendingPeriod,
  period2: SpendingPeriod,
): Promise<Comparison> {
  const summaryA = await getSpendingSummary(userId, period1);
  const summaryB = await getSpendingSummary(userId, period2);
  return {
    period1: summaryA,
    period2: summaryB,
    delta: summaryA.total - summaryB.total,
  };
}

export async function correctLastTransaction(userId: string, field: string, value: string): Promise<Transaction | null> {
  const row = await db
    .select()
    .from(transactions)
    .where(eq(transactions.user_id, userId))
    .orderBy(desc(transactions.created_at))
    .limit(1)
    .get();

  if (!row) {
    return null;
  }

  const normalizedField = field.toLowerCase();
  const updates: Partial<typeof transactions.$inferInsert> = { updated_at: Date.now() };

  if (normalizedField === 'merchant') {
    updates.merchant = value;
  } else if (normalizedField === 'category') {
    updates.category = await inferCategory({ merchant: row.merchant, note: value, amount: row.amount });
  } else if (normalizedField === 'note') {
    updates.note = value;
  } else if (normalizedField === 'amount') {
    const nextAmount = centsFromAmount(Number(value));
    const resolvedCurrency = resolveCurrency({
      currency: row.currency as Currency,
      cardName: row.card_name,
      merchant: row.merchant,
      note: row.note ?? undefined,
    });
    updates.amount = nextAmount;
    updates.amount_sgd = toSGD(nextAmount, resolvedCurrency);
  } else if (normalizedField === 'currency') {
    const nextCurrency = resolveCurrency({
      currency: value as Currency,
      cardName: row.card_name,
      merchant: row.merchant,
      note: row.note ?? undefined,
    });
    updates.currency = nextCurrency;
    updates.amount_sgd = toSGD(row.amount, nextCurrency);
  }

  const [updated] = await db.update(transactions).set(updates).where(eq(transactions.id, row.id)).returning();
  return mapTransactionRow(updated);
}

export async function exportCSV(userId: string, year: number): Promise<string> {
  const rows = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.user_id, userId),
        gte(transactions.created_at, new Date(year, 0, 1).getTime()),
        lt(transactions.created_at, new Date(year + 1, 0, 1).getTime()),
      ),
    )
    .orderBy(desc(transactions.created_at));

  const exportDir = path.resolve('./data/exports');
  fs.mkdirSync(exportDir, { recursive: true });

  const filePath = path.join(exportDir, `expenses-${userId}-${year}.csv`);
  const lines = [
    ['id', 'amount', 'currency', 'amount_sgd', 'merchant', 'category', 'source', 'card_name', 'note', 'created_at'].join(','),
    ...rows.map((row) =>
      [
        row.id,
        row.amount,
        row.currency,
        row.amount_sgd,
        row.merchant,
        row.category,
        row.source,
        row.card_name,
        row.note ?? '',
        row.created_at,
      ]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`)
        .join(','),
    ),
  ];

  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
}

// --- Recurring-transaction functions below are migrated in Task 7; left
// unchanged (raw SQL, no userId) for now. getSQLiteDb()/ensureDataDirectory()
// above stay in place until Task 7 removes them along with these. ---

export async function createRecurring(data: RecurringInput): Promise<any> {
  const db2 = getSQLiteDb();
  const amount = centsFromAmount(data.amount);
  const category = data.category ?? (await inferCategory({ merchant: data.merchant, amount }));
  const id = randomUUID();
  const now = Date.now();

  db2.prepare(
    `INSERT INTO recurring_transactions (id, amount, currency, merchant, category, day_of_month, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    amount,
    data.currency ?? 'SGD',
    data.merchant,
    category,
    data.day_of_month,
    data.is_active === undefined ? 1 : data.is_active ? 1 : 0,
    now,
    now,
  );

  const row = db2.prepare('SELECT * FROM recurring_transactions WHERE id = ?').get(id) as any;
  db2.close();
  return {
    ...row,
    is_active: Boolean(row.is_active),
    created_at: new Date(Number(row.created_at)),
    updated_at: new Date(Number(row.updated_at)),
  };
}

export async function pauseRecurring(id: string): Promise<void> {
  const db2 = getSQLiteDb();
  db2.prepare('UPDATE recurring_transactions SET is_active = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
  db2.close();
}

export async function removeRecurring(id: string): Promise<void> {
  const db2 = getSQLiteDb();
  db2.prepare('DELETE FROM recurring_transactions WHERE id = ?').run(id);
  db2.close();
}

export async function listRecurring(): Promise<any[]> {
  const db2 = getSQLiteDb();
  const rows = db2.prepare('SELECT * FROM recurring_transactions ORDER BY day_of_month ASC').all() as any[];
  db2.close();
  return rows.map((row) => ({
    ...row,
    is_active: Boolean(row.is_active),
    created_at: new Date(Number(row.created_at)),
    updated_at: new Date(Number(row.updated_at)),
  }));
}

export async function fireRecurringForToday(): Promise<Transaction[]> {
  const db2 = getSQLiteDb();
  const today = new Date().getDate();
  const recurringRows = db2
    .prepare('SELECT * FROM recurring_transactions WHERE is_active = 1 AND day_of_month = ?')
    .all(today) as any[];

  const created: Transaction[] = [];
  for (const recurring of recurringRows) {
    const amountSgd = toSGD(Number(recurring.amount), String(recurring.currency) as Currency);
    const insertedId = randomUUID();
    const now = Date.now();

    db2.prepare(
      `INSERT INTO transactions (id, user_id, amount, currency, amount_sgd, merchant, category, source, card_name, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      insertedId,
      'PLACEHOLDER_UNTIL_TASK_7',
      Number(recurring.amount),
      String(recurring.currency),
      amountSgd,
      String(recurring.merchant),
      String(recurring.category),
      'recurring',
      'Recurring',
      `Auto-logged recurring: ${recurring.merchant}`,
      now,
      now,
    );

    const insertedRow = db2.prepare('SELECT * FROM transactions WHERE id = ?').get(insertedId) as any;
    created.push(mapTransactionRow({ ...insertedRow, note: insertedRow.note } as typeof transactions.$inferSelect));
  }

  db2.close();
  return created;
}

export async function getRecurringFiredToday(): Promise<Transaction[]> {
  const start = startOfPeriod('today');
  const rows = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.source, 'recurring'), gte(transactions.created_at, start)))
    .orderBy(desc(transactions.created_at));
  return rows.map(mapTransactionRow);
}
```

The `fireRecurringForToday` body above is intentionally broken (`'PLACEHOLDER_UNTIL_TASK_7'` as the literal `user_id` value, which will fail the FK constraint against real data) — Task 7 replaces this entire function for real. It's left in this shape only so the file is syntactically complete between tasks; **do not** try to make it pass tests in this task. The two recurring tests that exercise it were moved out of this task's `expense.test.ts` rewrite in Step 1 specifically so this task's test run doesn't hit it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/expense/expense.test.ts`
Expected: PASS (6/6) — this file's tests no longer touch `createRecurring`/`fireRecurringForToday`, so the placeholder above isn't exercised yet.

- [ ] **Step 5: Commit**

```bash
git add src/expense/service.ts src/expense/expense.test.ts
git commit -m "refactor(expense): migrate transaction functions onto Drizzle, add userId scoping"
```

---

### Task 7: Migrate `expense/service.ts`'s recurring functions onto Drizzle + `userId`

Finishes the file's migration: removes the raw `better-sqlite3` path entirely (`getSQLiteDb`, `ensureDataDirectory`, the `Database` import), migrates `createRecurring`, `pauseRecurring`, `removeRecurring`, `listRecurring`, `fireRecurringForToday`, `getRecurringFiredToday` onto Drizzle, and fixes the placeholder `fireRecurringForToday` left by Task 6.

**Files:**
- Modify: `src/expense/service.ts`
- Modify: `src/expense/expense.test.ts`

**Interfaces:**
- Consumes: `recurring_transactions` from `../db/schema`, `RecurringTransaction` from `../types`
- Produces: `createRecurring(userId: string, data: RecurringInput): Promise<RecurringTransaction>`, `pauseRecurring(userId: string, id: string): Promise<void>`, `removeRecurring(userId: string, id: string): Promise<void>`, `listRecurring(userId: string): Promise<RecurringTransaction[]>`, `fireRecurringForToday(userId: string): Promise<Transaction[]>`, `getRecurringFiredToday(userId: string): Promise<Transaction[]>`

- [ ] **Step 1: Restore and extend the recurring tests in `src/expense/expense.test.ts` (RED)**

Append these tests to the end of the file (after `'exportCSV writes a per-user file...'`):

```typescript
test('recurring transactions can be fired for today', async () => {
  const { createRecurring, fireRecurringForToday } = await import('./index');
  const recurring = await createRecurring(userId, {
    amount: 2500,
    currency: 'SGD',
    merchant: 'Netflix',
    category: 'Entertainment',
    day_of_month: new Date().getDate(),
    is_active: true,
  });

  const fired = await fireRecurringForToday(userId);
  assert.ok(fired.some((item) => item.merchant === recurring.merchant));
});

test('getRecurringFiredToday reports already-fired recurring transactions without inserting new ones', async () => {
  const { createRecurring, fireRecurringForToday, getRecurringFiredToday } = await import('./index');
  const recurring = await createRecurring(userId, {
    amount: 500,
    currency: 'SGD',
    merchant: 'Spotify',
    category: 'Entertainment',
    day_of_month: new Date().getDate(),
    is_active: true,
  });

  await fireRecurringForToday(userId);

  const first = await getRecurringFiredToday(userId);
  const second = await getRecurringFiredToday(userId);

  assert.equal(first.length, second.length);
  assert.ok(first.some((t) => t.merchant === recurring.merchant));
  assert.ok(first.every((t) => t.source === 'recurring'));
});

test('fireRecurringForToday only fires the calling user\'s own due recurring entries', async () => {
  const { createUser } = await import('../users/service');
  const { createRecurring, fireRecurringForToday } = await import('./index');
  const otherUser = await createUser('test-expense-recurring-other-chat');

  await createRecurring(otherUser.id, {
    amount: 999,
    currency: 'SGD',
    merchant: 'Other User Gym',
    category: 'Health',
    day_of_month: new Date().getDate(),
    is_active: true,
  });

  const firedForUserId = await fireRecurringForToday(userId);
  assert.ok(!firedForUserId.some((t) => t.merchant === 'Other User Gym'));

  const firedForOtherUser = await fireRecurringForToday(otherUser.id);
  assert.ok(firedForOtherUser.some((t) => t.merchant === 'Other User Gym'));
});

test('removeRecurring only deletes when the id belongs to the calling user', async () => {
  const { createUser } = await import('../users/service');
  const { createRecurring, removeRecurring, listRecurring } = await import('./index');
  const otherUser = await createUser('test-expense-remove-recurring-other-chat');

  const theirs = await createRecurring(otherUser.id, {
    amount: 100,
    currency: 'SGD',
    merchant: 'Their Subscription',
    category: 'Entertainment',
    day_of_month: 1,
    is_active: true,
  });

  await removeRecurring(userId, theirs.id); // wrong user — should not delete

  const stillThere = await listRecurring(otherUser.id);
  assert.ok(stillThere.some((r) => r.id === theirs.id));

  await removeRecurring(otherUser.id, theirs.id); // correct user
  const gone = await listRecurring(otherUser.id);
  assert.ok(!gone.some((r) => r.id === theirs.id));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/expense/expense.test.ts`
Expected: FAIL — `createRecurring(userId, ...)` etc. don't match the old signatures, and the Task 6 placeholder would throw a FK error if reached.

- [ ] **Step 3: Replace the recurring section of `src/expense/service.ts`**

Remove `import Database from 'better-sqlite3';` from the top of the file, remove the `ensureDataDirectory` and `getSQLiteDb` functions entirely, add `recurring_transactions` to the `../db/schema` import and `RecurringTransaction` to the `../types` import, and replace everything from the `// --- Recurring-transaction functions below...` comment to the end of the file with:

```typescript
function mapRecurringRow(row: typeof recurring_transactions.$inferSelect): RecurringTransaction {
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency as Currency,
    merchant: row.merchant,
    category: row.category as Category,
    day_of_month: row.day_of_month,
    is_active: Boolean(row.is_active),
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

export async function createRecurring(userId: string, data: RecurringInput): Promise<RecurringTransaction> {
  const amount = centsFromAmount(data.amount);
  const category = data.category ?? (await inferCategory({ merchant: data.merchant, amount }));
  const now = Date.now();

  const [inserted] = await db
    .insert(recurring_transactions)
    .values({
      id: randomUUID(),
      user_id: userId,
      amount,
      currency: data.currency ?? 'SGD',
      merchant: data.merchant,
      category,
      day_of_month: data.day_of_month,
      is_active: data.is_active === undefined ? 1 : data.is_active ? 1 : 0,
      created_at: now,
      updated_at: now,
    })
    .returning();

  return mapRecurringRow(inserted);
}

export async function pauseRecurring(userId: string, id: string): Promise<void> {
  await db
    .update(recurring_transactions)
    .set({ is_active: 0, updated_at: Date.now() })
    .where(and(eq(recurring_transactions.id, id), eq(recurring_transactions.user_id, userId)));
}

export async function removeRecurring(userId: string, id: string): Promise<void> {
  await db
    .delete(recurring_transactions)
    .where(and(eq(recurring_transactions.id, id), eq(recurring_transactions.user_id, userId)));
}

export async function listRecurring(userId: string): Promise<RecurringTransaction[]> {
  const rows = await db
    .select()
    .from(recurring_transactions)
    .where(eq(recurring_transactions.user_id, userId))
    .orderBy(recurring_transactions.day_of_month);
  return rows.map(mapRecurringRow);
}

export async function fireRecurringForToday(userId: string): Promise<Transaction[]> {
  const today = new Date().getDate();
  const dueRows = await db
    .select()
    .from(recurring_transactions)
    .where(
      and(
        eq(recurring_transactions.user_id, userId),
        eq(recurring_transactions.is_active, 1),
        eq(recurring_transactions.day_of_month, today),
      ),
    );

  const created: Transaction[] = [];
  for (const recurring of dueRows) {
    const amountSgd = toSGD(recurring.amount, recurring.currency as Currency);
    const now = Date.now();

    const [inserted] = await db
      .insert(transactions)
      .values({
        id: randomUUID(),
        user_id: userId,
        amount: recurring.amount,
        currency: recurring.currency,
        amount_sgd: amountSgd,
        merchant: recurring.merchant,
        category: recurring.category,
        source: 'recurring',
        card_name: 'Recurring',
        note: `Auto-logged recurring: ${recurring.merchant}`,
        created_at: now,
        updated_at: now,
      })
      .returning();

    created.push(mapTransactionRow(inserted));
  }

  return created;
}

export async function getRecurringFiredToday(userId: string): Promise<Transaction[]> {
  const start = startOfPeriod('today');
  const rows = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.user_id, userId), eq(transactions.source, 'recurring'), gte(transactions.created_at, start)))
    .orderBy(desc(transactions.created_at));
  return rows.map(mapTransactionRow);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/expense/expense.test.ts`
Expected: PASS (10/10).

- [ ] **Step 5: Commit**

```bash
git add src/expense/service.ts src/expense/expense.test.ts
git commit -m "refactor(expense): migrate recurring functions onto Drizzle, remove raw SQL path"
```

---

### Task 8: `budget/service.ts` + `userId`

**Files:**
- Modify: `src/budget/service.ts`
- Modify: `src/budget/service.test.ts`

**Interfaces:**
- Produces: `setBudget(userId: string, category: Category, amount: number, currency?: Currency): Promise<Budget>`, `removeBudget(userId: string, category: Category): Promise<void>`, `listBudgets(userId: string): Promise<Budget[]>`, `findBudgetByCategory(userId: string, category: Category): Promise<Budget | null>`

- [ ] **Step 1: Update `src/budget/service.test.ts` (RED)**

Replace the whole file:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL = './data/test-budget-service.db';

const testDbPath = path.resolve('./data/test-budget-service.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let userId: string;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
  const { createUser } = await import('../users/service');
  const user = await createUser('test-budget-service-chat');
  userId = user.id;
});

test('setBudget creates a new budget with cents/SGD conversion', async () => {
  const { setBudget } = await import('./service');
  const budget = await setBudget(userId, 'Food', 800, 'SGD');

  assert.equal(budget.category, 'Food');
  assert.equal(budget.amount, 80000);
  assert.equal(budget.currency, 'SGD');
  assert.equal(budget.amount_sgd, 80000);
});

test('setBudget defaults to SGD when no currency is given', async () => {
  const { setBudget } = await import('./service');
  const budget = await setBudget(userId, 'Entertainment', 50);

  assert.equal(budget.currency, 'SGD');
  assert.equal(budget.amount_sgd, 5000);
});

test('setBudget updates an existing budget for the same category instead of duplicating', async () => {
  const { setBudget, listBudgets } = await import('./service');
  await setBudget(userId, 'Transport', 200, 'SGD');
  const updated = await setBudget(userId, 'Transport', 300, 'SGD');

  const all = await listBudgets(userId);
  const transportBudgets = all.filter((b) => b.category === 'Transport');

  assert.equal(transportBudgets.length, 1);
  assert.equal(updated.amount, 30000);
});

test('setBudget converts non-SGD currency using the static exchange rates', async () => {
  const { setBudget } = await import('./service');
  const budget = await setBudget(userId, 'Shopping', 100, 'MYR');

  assert.equal(budget.amount, 10000);
  assert.equal(budget.currency, 'MYR');
  assert.ok(budget.amount_sgd > 0);
  assert.notEqual(budget.amount_sgd, budget.amount);
});

test('removeBudget deletes the budget row', async () => {
  const { setBudget, removeBudget, listBudgets } = await import('./service');
  await setBudget(userId, 'Health', 100, 'SGD');
  await removeBudget(userId, 'Health');

  const all = await listBudgets(userId);
  assert.ok(!all.some((b) => b.category === 'Health'));
});

test('findBudgetByCategory returns null when no budget exists for that category', async () => {
  const { findBudgetByCategory } = await import('./service');
  const result = await findBudgetByCategory(userId, 'Education');
  assert.equal(result, null);
});

test('findBudgetByCategory returns the budget when one exists', async () => {
  const { setBudget, findBudgetByCategory } = await import('./service');
  await setBudget(userId, 'Groceries', 400, 'SGD');

  const found = await findBudgetByCategory(userId, 'Groceries');
  assert.ok(found);
  assert.equal(found!.amount_sgd, 40000);
});

test('two users can each set their own budget for the same category without colliding', async () => {
  const { createUser } = await import('../users/service');
  const { setBudget, findBudgetByCategory } = await import('./service');
  const otherUser = await createUser('test-budget-service-other-chat');

  await setBudget(userId, 'Travel', 500, 'SGD');
  await setBudget(otherUser.id, 'Travel', 900, 'SGD');

  const mine = await findBudgetByCategory(userId, 'Travel');
  const theirs = await findBudgetByCategory(otherUser.id, 'Travel');

  assert.equal(mine!.amount_sgd, 50000);
  assert.equal(theirs!.amount_sgd, 90000);
});

test('removeBudget only removes the calling user\'s budget for that category', async () => {
  const { createUser } = await import('../users/service');
  const { setBudget, removeBudget, findBudgetByCategory } = await import('./service');
  const otherUser = await createUser('test-budget-service-remove-other-chat');

  await setBudget(userId, 'Bills', 150, 'SGD');
  await setBudget(otherUser.id, 'Bills', 150, 'SGD');

  await removeBudget(userId, 'Bills');

  assert.equal(await findBudgetByCategory(userId, 'Bills'), null);
  assert.ok(await findBudgetByCategory(otherUser.id, 'Bills'));
});

test('removeBudget succeeds and cascades even after an alert has fired for that budget', async () => {
  const { setBudget, removeBudget, findBudgetByCategory } = await import('./service');
  const { db } = await import('../db');
  const { budget_alerts } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');

  const budget = await setBudget(userId, 'Insurance', 150, 'SGD');

  // Simulate an alert having already fired this month for this budget, which
  // is what previously made the FK constraint reject removeBudget's delete.
  await db.insert(budget_alerts).values({
    id: randomUUID(),
    user_id: userId,
    budget_id: budget.id,
    threshold: 80,
    month: '2026-08',
    sent_at: Date.now(),
  });

  await assert.doesNotReject(() => removeBudget(userId, 'Insurance'));

  const remainingBudget = await findBudgetByCategory(userId, 'Insurance');
  assert.equal(remainingBudget, null);

  const remainingAlerts = await db.select().from(budget_alerts).where(eq(budget_alerts.budget_id, budget.id));
  assert.equal(remainingAlerts.length, 0);
});
```

Note: `'Bills'` was reused as the alert-cascade test's category in the original file; renamed here to `'Insurance'` so it doesn't collide with the new `'removeBudget only removes the calling user\'s budget...'` test, which now legitimately owns `'Bills'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/budget/service.test.ts`
Expected: FAIL — `setBudget('Food', 800, 'SGD')`-shaped calls don't match the new `(userId, category, amount, currency)` signature.

- [ ] **Step 3: Update `src/budget/service.ts`**

Replace the whole file:

```typescript
/**
 * Budget CRUD service (Drizzle-backed).
 */

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { budgets } from '../db/schema';
import { toSGD } from '../config';
import { Category, Currency } from '../types';
import { Budget } from './types';

function mapBudgetRow(row: typeof budgets.$inferSelect): Budget {
  return {
    id: row.id,
    category: row.category as Category,
    amount: row.amount,
    currency: row.currency as Currency,
    amount_sgd: row.amount_sgd,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

export async function setBudget(
  userId: string,
  category: Category,
  amount: number,
  currency: Currency = 'SGD',
): Promise<Budget> {
  const amountCents = Math.max(0, Math.round(amount * 100));
  const amountSgd = toSGD(amountCents, currency);
  const now = Date.now();

  const existing = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.user_id, userId), eq(budgets.category, category)))
    .get();

  if (existing) {
    const [updated] = await db
      .update(budgets)
      .set({ amount: amountCents, currency, amount_sgd: amountSgd, updated_at: now })
      .where(eq(budgets.id, existing.id))
      .returning();
    return mapBudgetRow(updated);
  }

  const [inserted] = await db
    .insert(budgets)
    .values({
      id: randomUUID(),
      user_id: userId,
      category,
      amount: amountCents,
      currency,
      amount_sgd: amountSgd,
      period: 'monthly',
      created_at: now,
      updated_at: now,
    })
    .returning();

  return mapBudgetRow(inserted);
}

export async function removeBudget(userId: string, category: Category): Promise<void> {
  await db.delete(budgets).where(and(eq(budgets.user_id, userId), eq(budgets.category, category)));
}

export async function listBudgets(userId: string): Promise<Budget[]> {
  const rows = await db.select().from(budgets).where(eq(budgets.user_id, userId)).orderBy(budgets.category);
  return rows.map(mapBudgetRow);
}

export async function findBudgetByCategory(userId: string, category: Category): Promise<Budget | null> {
  const row = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.user_id, userId), eq(budgets.category, category)))
    .get();
  return row ? mapBudgetRow(row) : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/budget/service.test.ts`
Expected: PASS (10/10).

- [ ] **Step 5: Commit**

```bash
git add src/budget/service.ts src/budget/service.test.ts
git commit -m "feat(budget): scope budget CRUD by userId"
```

---

### Task 9: `budget/progress.ts` (`getBudgetStatus`) + `userId`

**Files:**
- Modify: `src/budget/progress.ts`
- Modify: `src/budget/progress.test.ts`

**Interfaces:**
- Consumes: `listBudgets(userId, ...)`, `getSpendingByCategory(userId, ...)` (Tasks 6, 8)
- Produces: `getBudgetStatus(userId: string): Promise<BudgetStatus[]>`

- [ ] **Step 1: Update `src/budget/progress.test.ts` (RED)**

Replace the whole file:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL = './data/test-budget-progress.db';

const testDbPath = path.resolve('./data/test-budget-progress.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let userId: string;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
  const { createUser } = await import('../users/service');
  const user = await createUser('test-budget-progress-chat');
  userId = user.id;
});

async function seedTransaction(forUserId: string, category: string, amountSgdCents: number): Promise<void> {
  const { db, transactions } = await import('../db');
  const now = Date.now();
  await db.insert(transactions).values({
    id: randomUUID(),
    user_id: forUserId,
    amount: amountSgdCents,
    currency: 'SGD',
    amount_sgd: amountSgdCents,
    merchant: 'Test merchant',
    category,
    source: 'text',
    card_name: 'Test',
    created_at: now,
    updated_at: now,
  });
}

test('getBudgetStatus computes percentage, remaining, and days left', async () => {
  const { setBudget } = await import('./service');
  const { getBudgetStatus } = await import('./progress');

  await setBudget(userId, 'Food', 100, 'SGD'); // S$100 budget
  await seedTransaction(userId, 'Food', 4000); // S$40 spent

  const statuses = await getBudgetStatus(userId);
  const food = statuses.find((s) => s.category === 'Food');

  assert.ok(food);
  assert.equal(food!.budget_sgd, 10000);
  assert.equal(food!.spent_sgd, 4000);
  assert.equal(food!.percentage, 40);
  assert.equal(food!.remaining_sgd, 6000);

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  assert.equal(food!.days_left_in_month, daysInMonth - now.getDate());
});

test('getBudgetStatus reports zero spend for a category with a budget but no transactions', async () => {
  const { setBudget } = await import('./service');
  const { getBudgetStatus } = await import('./progress');

  await setBudget(userId, 'Education', 50, 'SGD');

  const statuses = await getBudgetStatus(userId);
  const education = statuses.find((s) => s.category === 'Education');

  assert.ok(education);
  assert.equal(education!.spent_sgd, 0);
  assert.equal(education!.percentage, 0);
});

test('getBudgetStatus never mixes another user\'s spending into the calling user\'s status', async () => {
  const { createUser } = await import('../users/service');
  const { setBudget } = await import('./service');
  const { getBudgetStatus } = await import('./progress');
  const otherUser = await createUser('test-budget-progress-other-chat');

  await setBudget(userId, 'Shopping', 100, 'SGD');
  await setBudget(otherUser.id, 'Shopping', 100, 'SGD');
  await seedTransaction(otherUser.id, 'Shopping', 9000); // 90% for the other user only

  const myStatuses = await getBudgetStatus(userId);
  const myShopping = myStatuses.find((s) => s.category === 'Shopping');

  assert.ok(myShopping);
  assert.equal(myShopping!.spent_sgd, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/budget/progress.test.ts`
Expected: FAIL — `getBudgetStatus()` and `setBudget(...)` calls don't match the new signatures.

- [ ] **Step 3: Update `src/budget/progress.ts`**

```typescript
/**
 * Budget progress calculator — current month spend vs each budget.
 */

import { getSpendingByCategory } from '../expense/service';
import { listBudgets } from './service';
import { BudgetStatus } from './types';

function daysLeftInMonth(now: Date): number {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return daysInMonth - now.getDate();
}

export async function getBudgetStatus(userId: string): Promise<BudgetStatus[]> {
  const [budgetsList, spending] = await Promise.all([listBudgets(userId), getSpendingByCategory(userId, 'month')]);
  const spendByCategory = new Map(spending.map((entry) => [entry.category, entry.total]));
  const daysLeft = daysLeftInMonth(new Date());

  return budgetsList.map((budget) => {
    const spentSgd = spendByCategory.get(budget.category) ?? 0;
    const percentage =
      budget.amount_sgd > 0 ? Math.round((spentSgd / budget.amount_sgd) * 1000) / 10 : 0;

    return {
      category: budget.category,
      budget_amount: budget.amount,
      budget_currency: budget.currency,
      budget_sgd: budget.amount_sgd,
      spent_sgd: spentSgd,
      percentage,
      remaining_sgd: budget.amount_sgd - spentSgd,
      days_left_in_month: daysLeft,
    };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/budget/progress.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add src/budget/progress.ts src/budget/progress.test.ts
git commit -m "feat(budget): scope getBudgetStatus by userId"
```

---

### Task 10: `budget/alerts.ts` (`checkAlerts`) + `userId`

**Files:**
- Modify: `src/budget/alerts.ts`
- Modify: `src/budget/alerts.test.ts`

**Interfaces:**
- Consumes: `findBudgetByCategory(userId, ...)`, `getSpendingByCategory(userId, ...)` (Tasks 6, 8)
- Produces: `checkAlerts(userId: string, transaction: Transaction): Promise<Alert | null>`

- [ ] **Step 1: Update `src/budget/alerts.test.ts` (RED)**

Replace the whole file:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL = './data/test-budget-alerts.db';

const testDbPath = path.resolve('./data/test-budget-alerts.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let userId: string;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
  const { createUser } = await import('../users/service');
  const user = await createUser('test-budget-alerts-chat');
  userId = user.id;
});

async function insertTransaction(forUserId: string, category: string, amountSgdCents: number) {
  const { db, transactions } = await import('../db');
  const now = Date.now();
  const id = randomUUID();

  await db.insert(transactions).values({
    id,
    user_id: forUserId,
    amount: amountSgdCents,
    currency: 'SGD',
    amount_sgd: amountSgdCents,
    merchant: 'Test merchant',
    category,
    source: 'text',
    card_name: 'Test',
    created_at: now,
    updated_at: now,
  });

  return {
    id,
    amount: amountSgdCents,
    currency: 'SGD' as const,
    amount_sgd: amountSgdCents,
    merchant: 'Test merchant',
    category: category as any,
    source: 'text',
    card_name: 'Test',
    created_at: new Date(now),
    updated_at: new Date(now),
  };
}

test('checkAlerts returns null when there is no budget for the category', async () => {
  const { checkAlerts } = await import('./alerts');
  const txn = await insertTransaction(userId, 'Travel', 1000);

  const alert = await checkAlerts(userId, txn);
  assert.equal(alert, null);
});

test('checkAlerts fires once at 80% and not again for a later transaction under 100%', async () => {
  const { setBudget } = await import('./service');
  const { checkAlerts } = await import('./alerts');

  await setBudget(userId, 'Food', 100, 'SGD'); // S$100 budget

  const first = await insertTransaction(userId, 'Food', 8500); // 85%
  const firstAlert = await checkAlerts(userId, first);
  assert.ok(firstAlert);
  assert.equal(firstAlert!.threshold, 80);

  const second = await insertTransaction(userId, 'Food', 100); // 86%, still under 100%
  const secondAlert = await checkAlerts(userId, second);
  assert.equal(secondAlert, null);
});

test('checkAlerts fires the 100% alert once when spend crosses it', async () => {
  const { setBudget } = await import('./service');
  const { checkAlerts } = await import('./alerts');

  await setBudget(userId, 'Shopping', 100, 'SGD');

  const pushOver = await insertTransaction(userId, 'Shopping', 10500); // 105%
  const alert = await checkAlerts(userId, pushOver);
  assert.ok(alert);
  assert.equal(alert!.threshold, 100);

  const again = await insertTransaction(userId, 'Shopping', 100);
  const repeat = await checkAlerts(userId, again);
  assert.equal(repeat, null);
});

test('checkAlerts re-fires in a new month even if already sent in a previous month', async () => {
  const { setBudget, findBudgetByCategory } = await import('./service');
  const { checkAlerts } = await import('./alerts');
  const { db } = await import('../db');
  const { budget_alerts } = await import('../db/schema');

  await setBudget(userId, 'Bills', 100, 'SGD');
  const budget = await findBudgetByCategory(userId, 'Bills');
  assert.ok(budget);

  await db.insert(budget_alerts).values({
    id: randomUUID(),
    user_id: userId,
    budget_id: budget!.id,
    threshold: 80,
    month: '2000-01',
    sent_at: Date.now(),
  });

  const txn = await insertTransaction(userId, 'Bills', 8500);
  const alert = await checkAlerts(userId, txn);

  assert.ok(alert);
  assert.equal(alert!.threshold, 80);
});

test('checkAlerts never fires off another user\'s budget or spending', async () => {
  const { createUser } = await import('../users/service');
  const { setBudget } = await import('./service');
  const { checkAlerts } = await import('./alerts');
  const otherUser = await createUser('test-budget-alerts-other-chat');

  await setBudget(otherUser.id, 'Health', 100, 'SGD');
  // userId (the calling user) has no 'Health' budget at all.
  const txn = await insertTransaction(userId, 'Health', 9000);

  const alert = await checkAlerts(userId, txn);
  assert.equal(alert, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/budget/alerts.test.ts`
Expected: FAIL — `checkAlerts(txn)` doesn't match the new `(userId, txn)` signature.

- [ ] **Step 3: Update `src/budget/alerts.ts`**

```typescript
/**
 * Budget alert detection. Pure w.r.t. delivery — returns alert data,
 * does not know about Telegram. See src/scheduler/recurring.ts for delivery.
 */

import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { budget_alerts } from '../db/schema';
import { Transaction } from '../types';
import { getSpendingByCategory } from '../expense/service';
import { findBudgetByCategory } from './service';
import { Alert } from './types';

function currentMonthKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function markAlertSent(userId: string, budgetId: string, threshold: 80 | 100, month: string): Promise<boolean> {
  const existing = await db
    .select()
    .from(budget_alerts)
    .where(
      and(
        eq(budget_alerts.budget_id, budgetId),
        eq(budget_alerts.threshold, threshold),
        eq(budget_alerts.month, month),
      ),
    );

  if (existing.length > 0) {
    return false;
  }

  await db.insert(budget_alerts).values({
    id: randomUUID(),
    user_id: userId,
    budget_id: budgetId,
    threshold,
    month,
    sent_at: Date.now(),
  });

  return true;
}

function formatAlertMessage(category: string, threshold: 80 | 100, spentSgd: number, budgetSgd: number): string {
  const spent = (spentSgd / 100).toFixed(2);
  const limit = (budgetSgd / 100).toFixed(2);
  const icon = threshold === 100 ? '🚨' : '⚠️';
  const verb = threshold === 100 ? 'hit' : 'used';
  return `${icon} ${category} budget alert: you've ${verb} ${threshold}% (S$${spent} / S$${limit}) this month.`;
}

export async function checkAlerts(userId: string, transaction: Transaction): Promise<Alert | null> {
  const budget = await findBudgetByCategory(userId, transaction.category);
  if (!budget || budget.amount_sgd <= 0) {
    return null;
  }

  const spending = await getSpendingByCategory(userId, 'month');
  const spentSgd = spending.find((entry) => entry.category === transaction.category)?.total ?? 0;
  const percentage = (spentSgd / budget.amount_sgd) * 100;
  const month = currentMonthKey();

  if (percentage >= 100) {
    const fired = await markAlertSent(userId, budget.id, 100, month);
    await markAlertSent(userId, budget.id, 80, month);
    if (!fired) {
      return null;
    }
    return {
      budget_id: budget.id,
      category: budget.category,
      threshold: 100,
      message: formatAlertMessage(budget.category, 100, spentSgd, budget.amount_sgd),
    };
  }

  if (percentage >= 80) {
    const fired = await markAlertSent(userId, budget.id, 80, month);
    if (!fired) {
      return null;
    }
    return {
      budget_id: budget.id,
      category: budget.category,
      threshold: 80,
      message: formatAlertMessage(budget.category, 80, spentSgd, budget.amount_sgd),
    };
  }

  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/budget/alerts.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/budget/alerts.ts src/budget/alerts.test.ts
git commit -m "feat(budget): scope checkAlerts by userId"
```

---

### Task 11: `portfolio/service.ts` + `userId` (closes the "red window")

**Files:**
- Modify: `src/portfolio/service.ts`
- Modify: `src/portfolio/service.test.ts`

**Interfaces:**
- Produces: `addHolding(userId: string, input: HoldingInput): Promise<Holding>`, `removeHolding(userId: string, symbol: string): Promise<void>`, `replaceHoldingsForBroker(userId: string, broker: Broker, parsed: ParsedHolding[]): Promise<Holding[]>`, `listHoldings(userId: string): Promise<Holding[]>`

- [ ] **Step 1: Update `src/portfolio/service.test.ts` (RED)**

Replace the whole file:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-portfolio-service.db';

const testDbPath = path.resolve('./data/test-portfolio-service.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let userId: string;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
  const { createUser } = await import('../users/service');
  const user = await createUser('test-portfolio-service-chat');
  userId = user.id;
});

test('addHolding creates a new manual holding with broker null', async () => {
  const { addHolding } = await import('./service');
  const holding = await addHolding(userId, {
    symbol: 'BTC',
    name: 'Bitcoin',
    quantity: 0.5,
    asset_class: 'crypto',
    currency: 'USD',
    market: 'Crypto',
  });

  assert.equal(holding.symbol, 'BTC');
  assert.equal(holding.quantity, 0.5);
  assert.equal(holding.broker, null);
});

test('addHolding updates the existing manual holding for the same symbol instead of duplicating', async () => {
  const { addHolding, listHoldings } = await import('./service');
  await addHolding(userId, { symbol: 'ETH', name: 'Ethereum', quantity: 1, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });
  await addHolding(userId, { symbol: 'ETH', name: 'Ethereum', quantity: 2, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });

  const all = await listHoldings(userId);
  const ethHoldings = all.filter((h) => h.symbol === 'ETH');

  assert.equal(ethHoldings.length, 1);
  assert.equal(ethHoldings[0].quantity, 2);
});

test('removeHolding deletes only the manual holding with that symbol', async () => {
  const { addHolding, removeHolding, listHoldings } = await import('./service');
  await addHolding(userId, { symbol: 'DOGE', name: 'Dogecoin', quantity: 100, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });
  await removeHolding(userId, 'DOGE');

  const all = await listHoldings(userId);
  assert.ok(!all.some((h) => h.symbol === 'DOGE'));
});

test('replaceHoldingsForBroker inserts fresh holdings tagged with that broker', async () => {
  const { replaceHoldingsForBroker } = await import('./service');
  const inserted = await replaceHoldingsForBroker(userId, 'ibkr', [
    { symbol: 'AAPL', name: 'Apple Inc.', quantity: 10, asset_class: 'stocks_us', currency: 'USD', market: 'NASDAQ' },
  ]);

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].broker, 'ibkr');
  assert.equal(inserted[0].symbol, 'AAPL');
});

test('replaceHoldingsForBroker wipes only the target broker\'s rows, leaving other brokers and manual entries untouched', async () => {
  const { replaceHoldingsForBroker, addHolding, listHoldings } = await import('./service');

  await replaceHoldingsForBroker(userId, 'ibkr', [
    { symbol: 'MSFT', name: 'Microsoft', quantity: 5, asset_class: 'stocks_us', currency: 'USD', market: 'NASDAQ' },
  ]);
  await replaceHoldingsForBroker(userId, 'moomoo', [
    { symbol: 'SIA', name: 'Singapore Airlines', quantity: 100, asset_class: 'stocks_sg', currency: 'SGD', market: 'SGX' },
  ]);
  await addHolding(userId, { symbol: 'BNB', name: 'Binance Coin', quantity: 3, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });

  await replaceHoldingsForBroker(userId, 'ibkr', [
    { symbol: 'GOOG', name: 'Alphabet', quantity: 2, asset_class: 'stocks_us', currency: 'USD', market: 'NASDAQ' },
  ]);

  const all = await listHoldings(userId);
  assert.ok(!all.some((h) => h.symbol === 'MSFT'), 'old IBKR position should be gone');
  assert.ok(all.some((h) => h.symbol === 'GOOG'), 'new IBKR position should be present');
  assert.ok(all.some((h) => h.symbol === 'SIA'), 'moomoo holding should be untouched');
  assert.ok(all.some((h) => h.symbol === 'BNB'), 'manual holding should be untouched');
});

test('replaceHoldingsForBroker rejects an empty holdings list', async () => {
  const { replaceHoldingsForBroker } = await import('./service');
  await assert.rejects(() => replaceHoldingsForBroker(userId, 'ibkr', []));
});

test('replaceHoldingsForBroker never touches another user\'s holdings for the same broker', async () => {
  const { createUser } = await import('../users/service');
  const { replaceHoldingsForBroker, listHoldings } = await import('./service');
  const otherUser = await createUser('test-portfolio-service-other-chat');

  await replaceHoldingsForBroker(otherUser.id, 'ibkr', [
    { symbol: 'TSLA', name: 'Tesla', quantity: 1, asset_class: 'stocks_us', currency: 'USD', market: 'NASDAQ' },
  ]);

  // Replacing the calling user's own ibkr holdings must not wipe the other user's TSLA row.
  await replaceHoldingsForBroker(userId, 'ibkr', [
    { symbol: 'GOOG', name: 'Alphabet', quantity: 2, asset_class: 'stocks_us', currency: 'USD', market: 'NASDAQ' },
  ]);

  const theirs = await listHoldings(otherUser.id);
  assert.ok(theirs.some((h) => h.symbol === 'TSLA'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/portfolio/service.test.ts`
Expected: FAIL — `addHolding({...})` etc. don't match the new `(userId, input)` signatures.

- [ ] **Step 3: Update `src/portfolio/service.ts`**

```typescript
/**
 * Portfolio holdings CRUD service (Drizzle-backed).
 */

import { randomUUID } from 'crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db, getSQLiteDb } from '../db';
import { holdings } from '../db/schema';
import { AssetClass, Currency } from '../types';
import { Broker, Holding, HoldingInput, ParsedHolding } from './types';

function mapHoldingRow(row: typeof holdings.$inferSelect): Holding {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    asset_class: row.asset_class as AssetClass,
    quantity: row.quantity,
    currency: row.currency as Currency,
    market: row.market,
    broker: (row.broker as Broker | null) ?? null,
    cost_basis: row.cost_basis ?? undefined,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

/** Manual (crypto/cash) holdings only — never touches broker-sourced rows. */
export async function addHolding(userId: string, input: HoldingInput): Promise<Holding> {
  const now = Date.now();
  const existing = await db
    .select()
    .from(holdings)
    .where(and(eq(holdings.user_id, userId), eq(holdings.symbol, input.symbol), isNull(holdings.broker)))
    .get();

  if (existing) {
    const [updated] = await db
      .update(holdings)
      .set({
        name: input.name,
        asset_class: input.asset_class,
        quantity: input.quantity,
        currency: input.currency,
        market: input.market,
        updated_at: now,
      })
      .where(eq(holdings.id, existing.id))
      .returning();
    return mapHoldingRow(updated);
  }

  const [inserted] = await db
    .insert(holdings)
    .values({
      id: randomUUID(),
      user_id: userId,
      symbol: input.symbol,
      name: input.name,
      asset_class: input.asset_class,
      quantity: input.quantity,
      currency: input.currency,
      market: input.market,
      broker: null,
      created_at: now,
      updated_at: now,
    })
    .returning();

  return mapHoldingRow(inserted);
}

/** Manual (crypto/cash) holdings only — never touches broker-sourced rows. */
export async function removeHolding(userId: string, symbol: string): Promise<void> {
  await db
    .delete(holdings)
    .where(and(eq(holdings.user_id, userId), eq(holdings.symbol, symbol), isNull(holdings.broker)));
}

/**
 * Full snapshot replace, scoped to one broker AND one user: wipes that
 * user's existing holdings for that broker and inserts the statement's
 * ending positions. Never touches another user's rows, the other broker's
 * rows, or manually-entered holdings. Transactional: both delete and insert
 * succeed or both roll back.
 */
export async function replaceHoldingsForBroker(
  userId: string,
  broker: Broker,
  parsed: ParsedHolding[],
): Promise<Holding[]> {
  if (parsed.length === 0) {
    throw new Error(
      'Refusing to replace holdings with an empty list — an empty statement is almost always a parse failure, not an emptied account.',
    );
  }

  const now = Date.now();

  const sqliteDb = getSQLiteDb();
  return sqliteDb.transaction(() => {
    db.delete(holdings).where(and(eq(holdings.user_id, userId), eq(holdings.broker, broker))).run();

    const rows = parsed.map((h) => ({
      id: randomUUID(),
      user_id: userId,
      symbol: h.symbol,
      name: h.name,
      asset_class: h.asset_class,
      quantity: h.quantity,
      currency: h.currency,
      market: h.market,
      broker,
      created_at: now,
      updated_at: now,
    }));

    const inserted = db.insert(holdings).values(rows).returning().all();
    return inserted.map(mapHoldingRow);
  })();
}

export async function listHoldings(userId: string): Promise<Holding[]> {
  const rows = await db.select().from(holdings).where(eq(holdings.user_id, userId)).orderBy(holdings.symbol);
  return rows.map(mapHoldingRow);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/portfolio/service.test.ts`
Expected: PASS (7/7).

- [ ] **Step 5: Run the full suite to confirm the "red window" is closed**

Run: `npm test`
Expected: every test file that's been touched so far (Tasks 1–11) passes; files not yet touched (everything from Task 12 onward) will fail on signature mismatches until their own task lands — that's still expected, just a smaller remaining set than before. From this point on, each subsequent task's own `npm test` run should show only *its* target file(s) newly passing, without regressing anything already migrated.

- [ ] **Step 6: Commit**

```bash
git add src/portfolio/service.ts src/portfolio/service.test.ts
git commit -m "feat(portfolio): scope holdings CRUD by userId"
```

---

### Task 12: `portfolio/index.ts`'s `getPortfolioSummary` + `userId`

A thin wrapper with no dedicated test file of its own — it's already exercised indirectly by `bot/handlers/document.test.ts` (Task 14) and `portfolio/calculator.test.ts` (unaffected, tests `buildPortfolioSummary` directly, not this wrapper). No new test file needed here; Task 14 covers it.

**Files:**
- Modify: `src/portfolio/index.ts`

**Interfaces:**
- Consumes: `listHoldings(userId)` (Task 11)
- Produces: `getPortfolioSummary(userId: string): Promise<PortfolioSummary>`

- [ ] **Step 1: Update `src/portfolio/index.ts`**

Change only the final function:

```typescript
export async function getPortfolioSummary(userId: string): Promise<PortfolioSummary> {
  const holdingsList = await listHoldings(userId);
  const enriched = await Promise.all(
    holdingsList.map(async (holding) => enrichHolding(holding, await getPrice(holding))),
  );
  return buildPortfolioSummary(enriched);
}
```

(Everything else in the file — the `export *`/`export {...}` re-export lines — is unchanged.)

- [ ] **Step 2: Verify the project still typechecks**

Run: `npx tsc --noEmit`
Expected: errors only at this function's remaining callers (`bot/commands/portfolio.ts`, `bot/handlers/document.ts`) — both fixed in later tasks (16 and 22). This step is a checkpoint, not a gate; move on.

- [ ] **Step 3: Commit**

```bash
git add src/portfolio/index.ts
git commit -m "feat(portfolio): scope getPortfolioSummary by userId"
```

---

### Task 13: `classifyUserMessage` + `inferCategory` route through `getProviderForUser`

**Files:**
- Modify: `src/expense/categorizer.ts`
- Modify: `src/expense/service.ts` (three call sites: `logExpense`, `correctLastTransaction`, `createRecurring`)
- Modify: `src/bot/ai.ts` (`classifyUserMessage` only — `buildAssistantReply` is Task 18)
- Modify: `src/bot/ai.test.ts` (the two `classifyUserMessage` tests + a shared `before()`)

**Interfaces:**
- Consumes: `getProviderForUser` (Task 5), `findById` (Task 4)
- Produces: `inferCategory(userId: string, input: {...}): Promise<Category>`, `classifyUserMessage(userId: string, rawText: string): Promise<IntentAnalysis>`

- [ ] **Step 1: Update the shared `before()` and the two `classifyUserMessage` tests in `src/bot/ai.test.ts` (RED)**

At the top of the file, add a module-level `let userId: string;` (next to any existing shared state) and replace the `before` hook:

```typescript
let userId: string;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const user = await createUser('test-ai-chat');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-stubbed-tests'), true); // isAdmin so it lands on 'approved' immediately
  userId = user.id;
});
```

Replace the two `classifyUserMessage`-related tests:

```typescript
test(
  'classifyUserMessage returns expense intent for a real Gemini call',
  { skip: !process.env.RUN_LIVE_AI_TESTS && 'set RUN_LIVE_AI_TESTS=1 to run this against the real Gemini API' },
  async () => {
    const { classifyUserMessage } = await import('./ai');
    const { setProvider, completeSetup } = await import('../users/service');
    const { encrypt } = await import('../users/crypto');
    const { config } = await import('../config');

    await setProvider(userId, 'gemini');
    await completeSetup(userId, encrypt(config.GOOGLE_API_KEY), true);

    const result = await classifyUserMessage(userId, 'Spent $4.50 at Ya Kun');
    assert.equal(result.intent, 'expense');
    assert.equal(result.serviceError, undefined);
  },
);

test('classifyUserMessage degrades gracefully instead of guessing when the Gemini call fails', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { classifyUserMessage } = await import('./ai');
    const result = await classifyUserMessage(userId, 'Spent $4.50 at Ya Kun');
    assert.equal(result.intent, 'unknown');
    assert.equal(result.serviceError, true);
  } finally {
    global.fetch = originalFetch;
  }
});
```

Leave every other test in the file (the `buildAssistantReply` ones) untouched for now — they still call `buildAssistantReply` directly without a `userId`, which still works because `buildAssistantReply` doesn't gain that parameter until Task 18.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/bot/ai.test.ts`
Expected: FAIL on the two updated tests (`classifyUserMessage(userId, ...)` doesn't match the current one-argument signature) — the `buildAssistantReply` tests still pass at this point.

- [ ] **Step 3: Update `src/expense/categorizer.ts`**

Replace the whole file:

```typescript
/**
 * AI-powered expense categorization, tuned for Singapore / Malaysia usage.
 */

import { getProviderForUser } from '../llm/provider';
import { findById } from '../users/service';
import { Category } from '../types';
import { logger } from '../utils/logger';

const VALID_CATEGORIES: readonly Category[] = [
  'Food',
  'Transport',
  'Groceries',
  'Entertainment',
  'Bills',
  'Health',
  'Education',
  'Travel',
  'Shopping',
  'Others',
] as const;

interface CategorizationResult {
  category: Category;
  confidence: number;
}

function safeJsonParse(text: string): Partial<CategorizationResult> | null {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function normalizeCategoryName(rawCategory: string): Category {
  const normalized = rawCategory.trim();
  const match = VALID_CATEGORIES.find((cat) => cat.toLowerCase() === normalized.toLowerCase());
  return match || 'Others';
}

/**
 * Use the calling user's own LLM provider to categorize an expense based on
 * merchant name and note. Falls back to 'Others' if categorization fails.
 */
export async function inferCategory(
  userId: string,
  input: { merchant?: string; note?: string; amount?: number },
): Promise<Category> {
  const haystack = [input.merchant, input.note].filter(Boolean).join(' ');

  if (!haystack.trim()) {
    return 'Others';
  }

  try {
    const user = await findById(userId);
    if (!user) {
      throw new Error(`No user found with id ${userId}`);
    }
    const provider = getProviderForUser(user);

    const prompt = `Merchant: "${input.merchant || 'unknown'}"
Note: "${input.note || ''}"
Amount: ${input.amount ? `$${(input.amount / 100).toFixed(2)}` : 'unknown'}

Return only JSON with category and confidence.`;

    const response = await provider.generateText({
      systemInstruction: `You are an expense categorization assistant for users in Singapore and Malaysia.
Categorize expenses into exactly one of these categories: ${VALID_CATEGORIES.join(', ')}.

Guidelines:
- Food: cafes, restaurants, hawker centers, kopi, mamak, food delivery
- Transport: Grab, taxis, MRT, LRT, buses, parking, fuel
- Groceries: supermarkets, FairPrice, Giant, Cold Storage, wet markets
- Entertainment: movies, Netflix, Spotify, concerts, games
- Bills: rent, utilities, phone bills, insurance, subscriptions
- Health: clinics, hospitals, pharmacies, doctors, medicine
- Education: tuition, courses, books, schools
- Travel: flights, hotels, AirAsia, Booking.com, trips
- Shopping: malls, clothes, electronics, online shopping
- Others: anything that doesn't fit above

Return only valid JSON with keys: category, confidence (0-1).`,
      contents: [{ text: prompt }],
    });

    const parsed = safeJsonParse(response);

    if (!parsed || !parsed.category) {
      logger.warn('Gemini categorization failed to return valid category', { response, haystack });
      return 'Others';
    }

    const category = normalizeCategoryName(parsed.category);
    logger.info('AI categorization', {
      merchant: input.merchant,
      note: input.note,
      category,
      confidence: parsed.confidence,
    });

    return category;
  } catch (error) {
    logger.error('Gemini categorization failed', error);
    return 'Others';
  }
}
```

- [ ] **Step 4: Update the three `inferCategory` call sites in `src/expense/service.ts`**

In `logExpense`, change:
```typescript
const category = await inferCategory({ merchant, note: data.note, amount: amountCents });
```
to:
```typescript
const category = await inferCategory(userId, { merchant, note: data.note, amount: amountCents });
```

In `correctLastTransaction`, change:
```typescript
updates.category = await inferCategory({ merchant: row.merchant, note: value, amount: row.amount });
```
to:
```typescript
updates.category = await inferCategory(userId, { merchant: row.merchant, note: value, amount: row.amount });
```

In `createRecurring`, change:
```typescript
const category = data.category ?? (await inferCategory({ merchant: data.merchant, amount }));
```
to:
```typescript
const category = data.category ?? (await inferCategory(userId, { merchant: data.merchant, amount }));
```

- [ ] **Step 5: Update `classifyUserMessage` in `src/bot/ai.ts`**

Replace the imports at the top of the file — remove `import { GoogleGenerativeAI } from '@google/generative-ai';` and add:

```typescript
import { getProviderForUser } from '../llm/provider';
import { findById } from '../users/service';
```

Replace the `classifyUserMessage` function body:

```typescript
export async function classifyUserMessage(userId: string, rawText: string): Promise<IntentAnalysis> {
  const trimmed = rawText.trim();

  if (!trimmed) {
    return {
      intent: 'unknown',
      confidence: 0,
      extracted: {},
      rawText: '',
    };
  }

  try {
    const user = await findById(userId);
    if (!user) {
      throw new Error(`No user found with id ${userId}`);
    }
    const provider = getProviderForUser(user);

    const prompt = `User message: "${trimmed}"\n\nReturn only valid JSON with keys intent, confidence, extracted, rawText.`;

    // gemini-3.6-flash's reasoning overhead routinely takes ~5s for this
    // prompt, so the timeout needs enough headroom to not misfire as a
    // service error.
    const response = await provider.generateText({
      systemInstruction:
        'You are Pluto AI, a personal finance assistant in Telegram. Classify each user message and return strict JSON only. Return fields: intent, confidence, extracted { amount, merchant, category, period, budgetAmount, action, symbol, assetClass, currency, dayOfMonth }, rawText. Allowed intents: expense, query, budget, correction, recurring, holdings, help, unknown. The holdings intent covers non-brokerage portfolio updates like "I hold 0.5 BTC" or "cash SGD 5000" — extract symbol (e.g. BTC, SGD), assetClass (crypto or cash), currency, and amount as the quantity. The recurring intent covers repeating charges like "Netflix $15.98 every 5th" or "cancel my Spotify subscription" — extract merchant, amount, and dayOfMonth (1-31, the day of the month it recurs on) for a new one, or action="remove" and merchant for cancelling an existing one. The query intent covers spending questions like "how much did I spend this week" — extract period as one of today, week, or month. Use decimal numbers for money values like 4.5. Keep responses concise and practical.',
      contents: [{ text: prompt }],
      timeoutMs: 15000,
    });

    const parsed = safeJsonParse(response);

    if (!parsed) {
      logger.warn('Gemini returned an unparseable response, degrading to unknown intent', { response });
      return gracefulUnknown(trimmed);
    }

    const intent = (parsed.intent as BotIntent | undefined) ?? 'unknown';
    const confidence = Number(parsed.confidence ?? 0.7);

    return {
      intent,
      confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.7,
      extracted: parsed.extracted ?? {},
      rawText: String(parsed.rawText ?? trimmed),
    };
  } catch (error) {
    logger.error('Gemini classification failed', error);
    return gracefulUnknown(trimmed);
  }
}
```

(`buildAssistantReply` below this function is untouched in this task.)

- [ ] **Step 6: Run the ai.test.ts and expense.test.ts suites to verify they pass**

Run: `npx tsx --test src/bot/ai.test.ts src/expense/expense.test.ts`
Expected: PASS for both files (the `buildAssistantReply` tests in `ai.test.ts` still pass unchanged — they don't call `classifyUserMessage` or `inferCategory` directly).

- [ ] **Step 7: Commit**

```bash
git add src/expense/categorizer.ts src/expense/service.ts src/bot/ai.ts src/bot/ai.test.ts
git commit -m "feat(ai): route classifyUserMessage and inferCategory through getProviderForUser"
```

---

### Task 14: `parseStatement` routes through `getProviderForUser`

**Files:**
- Modify: `src/portfolio/statement-parser.ts`
- Modify: `src/bot/handlers/document.ts`
- Modify: `src/bot/handlers/document.test.ts`

**Interfaces:**
- Produces: `parseStatement(userId: string, pdfBuffer: Buffer): Promise<ParsedStatement>`, `handleDocumentMessage(userId: string, fileBuffer: Buffer, mimeType: string): Promise<string>`

- [ ] **Step 1: Update `src/bot/handlers/document.test.ts` (RED)**

Replace the whole file:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-document-handler.db';

const testDbPath = path.resolve('./data/test-document-handler.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let userId: string;

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  runMigrations();
  const { createUser, setProvider, completeSetup } = await import('../../users/service');
  const { encrypt } = await import('../../users/crypto');
  const user = await createUser('test-document-handler-chat');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-tests'), true);
  userId = user.id;
});

test('handleDocumentMessage rejects a non-PDF file without calling Gemini', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error('should not be called');
  }) as typeof fetch;

  try {
    const { handleDocumentMessage } = await import('./document');
    const reply = await handleDocumentMessage(userId, Buffer.from('not a pdf'), 'image/png');

    assert.match(reply, /PDF/i);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleDocumentMessage returns a friendly message when statement parsing fails', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { handleDocumentMessage } = await import('./document');
    const reply = await handleDocumentMessage(userId, Buffer.from('%PDF-1.4 fake'), 'application/pdf');

    assert.match(reply, /couldn't read/i);
  } finally {
    global.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/bot/handlers/document.test.ts`
Expected: FAIL — `handleDocumentMessage(userId, ...)` doesn't match the current two-argument signature.

- [ ] **Step 3: Update `src/portfolio/statement-parser.ts`**

Replace the imports and the `parseStatement` function:

```typescript
import { getProviderForUser } from '../llm/provider';
import { findById } from '../users/service';
import { Broker, ParsedHolding, ParsedStatement } from './types';

// ... (VALID_ASSET_CLASSES, VALID_STATEMENT_CURRENCIES, SYSTEM_INSTRUCTION, StatementParseError, parseGeminiStatementResponse unchanged) ...

export async function parseStatement(userId: string, pdfBuffer: Buffer): Promise<ParsedStatement> {
  try {
    const user = await findById(userId);
    if (!user) {
      throw new StatementParseError(`No user found with id ${userId}`);
    }
    const provider = getProviderForUser(user);

    // Multimodal PDF calls run slower than short text-classification prompts
    // (ai.ts's 15s budget) — 30s gives enough headroom to not misfire.
    const response = await provider.generateText({
      systemInstruction: SYSTEM_INSTRUCTION,
      contents: [
        { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { text: 'Extract the holdings as instructed and return only the JSON.' },
      ],
      timeoutMs: 30000,
    });

    return parseGeminiStatementResponse(response);
  } catch (error) {
    if (error instanceof StatementParseError) {
      throw error;
    }
    throw new StatementParseError(`Gemini statement parsing failed: ${(error as Error).message}`);
  }
}
```

(Remove the now-unused `import { GoogleGenerativeAI } from '@google/generative-ai';` and `import { config } from '../config';` lines from the top of the file if nothing else in it still uses them — `config` isn't referenced elsewhere in this file.)

- [ ] **Step 4: Update `src/bot/handlers/document.ts`**

```typescript
/**
 * Statement PDF upload handling for the Telegram bot.
 */

import { logger } from '../../utils/logger';
import { parseStatement, StatementParseError } from '../../portfolio/statement-parser';
import { replaceHoldingsForBroker } from '../../portfolio/service';
import { getPortfolioSummary } from '../../portfolio';
import { formatCurrency } from '../../config';

export async function handleDocumentMessage(userId: string, fileBuffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType !== 'application/pdf') {
    return "I can only read PDF statements right now — please upload your IBKR or Moomoo statement as a PDF.";
  }

  let parsed;
  try {
    parsed = await parseStatement(userId, fileBuffer);
  } catch (error) {
    if (error instanceof StatementParseError) {
      logger.warn('Statement parse failed', { message: error.message });
      return `I couldn't read that statement (${error.message}). Try re-uploading, or check it's an IBKR/Moomoo statement PDF.`;
    }
    throw error;
  }

  const updated = await replaceHoldingsForBroker(userId, parsed.broker, parsed.holdings);
  const summary = await getPortfolioSummary(userId);

  return `Updated ${parsed.broker.toUpperCase()} holdings — ${updated.length} position(s). New net worth: ${formatCurrency(summary.net_worth_sgd, 'SGD')}.`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test src/bot/handlers/document.test.ts`
Expected: PASS (2/2).

- [ ] **Step 6: Commit**

```bash
git add src/portfolio/statement-parser.ts src/bot/handlers/document.ts src/bot/handlers/document.test.ts
git commit -m "feat(portfolio): route parseStatement through getProviderForUser"
```

---

### Task 15: `generateSummaryLine` + `collectDigestData` take `userId`

`generateSummaryLine` keeps its pre-existing rule-based fallback (see Global Constraints) — this task only threads `userId` through to `getProviderForUser`, it does not remove the fallback. `buildDigestMessage`/`triggerDigestNow` (which call these) are updated in Task 24 once the cron-loop-over-users design is also in place — until then they still call the two functions positionally-wrong, which Task 24 fixes; don't try to make `digest/index.ts` compile in this task.

**Files:**
- Modify: `src/digest/summary.ts`
- Modify: `src/digest/aggregator.ts`
- Modify: `src/digest/digest.test.ts` (only the `collectDigestData`/`generateSummaryLine` tests)

**Interfaces:**
- Produces: `generateSummaryLine(userId: string, data: DigestData): Promise<string>`, `collectDigestData(userId: string): Promise<DigestData>`

- [ ] **Step 1: Update the digest tests that call these two functions directly (RED)**

In `src/digest/digest.test.ts`, add a shared test user. Change the `before` hook to:

```typescript
let userId: string;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const user = await createUser('test-digest-chat');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-tests'), true);
  userId = user.id;

  // No test in this file needs a real Gemini call — stub fetch so
  // generateSummaryLine deterministically falls back to its rule-based
  // line, keeping the suite network-free by default.
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;
});
```

Update `'collectDigestData returns real data for all live sources and a permanent portfolio stub'`:

```typescript
test('collectDigestData returns real data for all live sources and a permanent portfolio stub', async () => {
  const { collectDigestData } = await import('./aggregator');
  const data = await collectDigestData(userId);

  assert.ok('total' in (data.spending as object));
  assert.ok(Array.isArray(data.recurringFired));
  assert.ok(Array.isArray(data.budgetStatuses));
  assert.deepEqual(data.portfolio, { error: 'not yet implemented' });
});
```

Update the two `generateSummaryLine` tests to pass `userId` as the first argument:

```typescript
test('generateSummaryLine falls back to "Watch {category} spending." when a budget is at or above 80%', async () => {
  const { generateSummaryLine } = await import('./summary');

  const data = {
    spending: emptySpending(),
    recurringFired: [],
    budgetStatuses: [
      {
        category: 'Food',
        budget_amount: 10000,
        budget_currency: 'SGD',
        budget_sgd: 10000,
        spent_sgd: 9000,
        percentage: 90,
        remaining_sgd: 1000,
        days_left_in_month: 2,
      },
    ],
    portfolio: { error: 'not yet implemented' },
  };

  const line = await generateSummaryLine(userId, data as any);
  assert.equal(line, 'Watch Food spending.');
});

test('generateSummaryLine falls back to "All good." when no budget is over threshold', async () => {
  const { generateSummaryLine } = await import('./summary');

  const data = {
    spending: emptySpending(),
    recurringFired: [],
    budgetStatuses: [],
    portfolio: { error: 'not yet implemented' },
  };

  const line = await generateSummaryLine(userId, data as any);
  assert.equal(line, 'All good.');
});
```

Leave every other test in the file untouched for now.

- [ ] **Step 2: Run the affected tests to verify they fail**

Run: `npx tsx --test --test-name-pattern="collectDigestData|generateSummaryLine" src/digest/digest.test.ts`
Expected: FAIL — signatures don't match yet.

- [ ] **Step 3: Update `src/digest/aggregator.ts`**

```typescript
/**
 * Collects digest data from the expense and budget modules. Each source is
 * isolated — one failing source degrades to a SectionResult error and never
 * blocks or fails the others.
 */

import { getSpendingSummary, getRecurringFiredToday } from '../expense';
import { getBudgetStatus } from '../budget';
import { logger } from '../utils/logger';
import { DigestData, SectionResult } from './types';

export async function settle<T>(section: string, promise: Promise<T>): Promise<SectionResult<T>> {
  try {
    return await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Digest section "${section}" failed, degrading gracefully`, { error: message });
    return { error: message };
  }
}

export async function collectDigestData(userId: string): Promise<DigestData> {
  const [spending, recurringFired, budgetStatuses] = await Promise.all([
    settle('spending', getSpendingSummary(userId, 'today')),
    settle('recurringFired', getRecurringFiredToday(userId)),
    settle('budgetStatuses', getBudgetStatus(userId)),
  ]);

  return {
    spending,
    recurringFired,
    budgetStatuses,
    portfolio: { error: 'not yet implemented' },
  };
}
```

- [ ] **Step 4: Update `src/digest/summary.ts`**

Replace the imports and `generateSummaryLine`:

```typescript
import { getProviderForUser } from '../llm/provider';
import { findById } from '../users/service';
import { logger } from '../utils/logger';
import { DigestData, SectionResult } from './types';

// ... isError, ruleBasedSummary, buildPrompt unchanged ...

export async function generateSummaryLine(userId: string, data: DigestData): Promise<string> {
  try {
    const user = await findById(userId);
    if (!user) {
      throw new Error(`No user found with id ${userId}`);
    }
    const provider = getProviderForUser(user);

    const text = (
      await provider.generateText({
        systemInstruction:
          'You are Pluto AI, a personal finance assistant. Reply with exactly one short plain-text sentence, no markdown, no quotes.',
        contents: [{ text: buildPrompt(data) }],
        timeoutMs: 5000,
      })
    ).trim();

    if (!text) {
      logger.warn('Gemini returned an empty digest summary, falling back to rule-based line');
      return ruleBasedSummary(data);
    }

    return text;
  } catch (error) {
    logger.error('Gemini digest summary failed, falling back to rule-based line', error);
    return ruleBasedSummary(data);
  }
}
```

(Remove the now-unused `import { GoogleGenerativeAI } from '@google/generative-ai';` and `import { config } from '../config';` lines.)

- [ ] **Step 5: Run the affected tests to verify they pass**

Run: `npx tsx --test --test-name-pattern="collectDigestData|generateSummaryLine" src/digest/digest.test.ts`
Expected: PASS (3/3). (The rest of `digest.test.ts` — `triggerDigestNow`/`buildDigestMessage` tests — still fail until Task 24; that's expected.)

- [ ] **Step 6: Commit**

```bash
git add src/digest/aggregator.ts src/digest/summary.ts src/digest/digest.test.ts
git commit -m "feat(digest): route collectDigestData and generateSummaryLine through userId"
```

---

### Task 16: Split (`extraction.ts`, `assignment.ts`, `split.ts`) routes through `getProviderForUser`

This is the "spec gap found during planning" fix (see File Structure section above) — `extractReceipt` and `parseSplitInstructions` currently construct `GoogleGenerativeAI(config.GOOGLE_API_KEY)` directly, which would be a compile error once `GOOGLE_API_KEY` is removed (Task 26).

**Files:**
- Modify: `src/split/extraction.ts`
- Modify: `src/split/assignment.ts`
- Modify: `src/bot/commands/split.ts`
- Modify: `src/bot/commands/split.test.ts`

**Interfaces:**
- Produces: `extractReceipt(userId: string, photoBuffer: Buffer, mimeType: string): Promise<ExtractedReceipt>`, `parseSplitInstructions(userId: string, freeText: string, items: ReceiptItem[]): Promise<SplitInstructions>`, `handleSplitPhoto(chatId: number, userId: string, photoBuffer: Buffer, mimeType: string): Promise<string>`, `handleSplitTextMessage(chatId: number, userId: string, message: string): Promise<string>`

- [ ] **Step 1: Update `src/bot/commands/split.test.ts` (RED)**

Replace the whole file:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-split-command.db';

const testDbPath = path.resolve('./data/test-split-command.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let userId: string;

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  runMigrations();
  const { createUser, setProvider, completeSetup } = await import('../../users/service');
  const { encrypt } = await import('../../users/crypto');
  const user = await createUser('test-split-command-chat');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-tests'), true);
  userId = user.id;
});

/**
 * Queues canned Gemini text responses in call order, regardless of which
 * Gemini call site makes the request — simpler than content-sniffing since
 * this orchestration layer's tests care about sequencing, not prompt
 * content (extraction.ts/assignment.ts/categorizer.ts already have their
 * own dedicated prompt-parsing tests).
 */
function stubGeminiSequence(responses: string[]): () => void {
  const originalFetch = global.fetch;
  let callIndex = 0;

  global.fetch = (async () => {
    const text = responses[Math.min(callIndex, responses.length - 1)];
    callIndex += 1;
    const body = JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  return () => {
    global.fetch = originalFetch;
  };
}

const EVEN_SPLIT_RESPONSE = JSON.stringify({
  mode: 'even',
  headcount: 2,
  itemAssignments: null,
  requesterLabel: 'me',
});

const CATEGORY_RESPONSE = JSON.stringify({ category: 'Food', confidence: 0.9 });

test('handleSplitCommand starts a split and asks for a photo', async () => {
  const { handleSplitCommand } = await import('./split');
  const { getSplitState } = await import('../../split/state');

  const reply = handleSplitCommand(3001);

  assert.match(reply, /photo/i);
  assert.equal(getSplitState(3001)?.stage, 'awaiting_photo');
});

test('handleCancelCommand clears an active split and reports nothing to cancel otherwise', async () => {
  const { handleSplitCommand, handleCancelCommand } = await import('./split');
  const { getSplitState } = await import('../../split/state');

  handleSplitCommand(3002);
  assert.match(handleCancelCommand(3002), /cancelled/i);
  assert.equal(getSplitState(3002), undefined);

  assert.match(handleCancelCommand(3002), /nothing to cancel/i);
});

test('handleSplitPhoto without an active split hints at /split instead of calling Gemini', async () => {
  const { handleSplitPhoto } = await import('./split');
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error('should not be called');
  }) as typeof fetch;

  try {
    const reply = await handleSplitPhoto(3003, userId, Buffer.from('fake jpeg'), 'image/jpeg');
    assert.match(reply, /split/i);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleSplitPhoto extracts a receipt and moves to awaiting_instructions', async () => {
  const { handleSplitCommand, handleSplitPhoto } = await import('./split');
  const { getSplitState } = await import('../../split/state');

  handleSplitCommand(3004);
  const receiptResponse = JSON.stringify({
    merchant: 'Ya Kun',
    items: [
      { name: 'Kaya Toast', price: 5 },
      { name: 'Iced Milo', price: 5 },
    ],
    taxAndTip: 0,
    total: 10,
    currency: 'SGD',
  });
  const restore = stubGeminiSequence([receiptResponse]);

  try {
    const reply = await handleSplitPhoto(3004, userId, Buffer.from('fake jpeg'), 'image/jpeg');
    assert.match(reply, /Ya Kun/);
    assert.equal(getSplitState(3004)?.stage, 'awaiting_instructions');
  } finally {
    restore();
  }
});

test('handleSplitPhoto keeps the flow at awaiting_photo and replies with an error when extraction fails', async () => {
  const { handleSplitCommand, handleSplitPhoto } = await import('./split');
  const { getSplitState } = await import('../../split/state');

  handleSplitCommand(3005);
  const restore = stubGeminiSequence(['not valid json']);

  try {
    const reply = await handleSplitPhoto(3005, userId, Buffer.from('fake jpeg'), 'image/jpeg');
    assert.match(reply, /couldn't read/i);
    assert.equal(getSplitState(3005)?.stage, 'awaiting_photo');
  } finally {
    restore();
  }
});

test('handleSplitTextMessage while awaiting_photo replies helpfully and leaves the stage unchanged', async () => {
  const { handleSplitCommand, handleSplitTextMessage } = await import('./split');
  const { getSplitState } = await import('../../split/state');

  handleSplitCommand(3009);
  const reply = await handleSplitTextMessage(3009, userId, 'ok');

  assert.match(reply, /photo/i);
  assert.equal(getSplitState(3009)?.stage, 'awaiting_photo');
});

test('handleSplitTextMessage: even split then Yes logs only the requester share', async () => {
  const { handleSplitCommand, handleSplitPhoto, handleSplitTextMessage } = await import('./split');
  const { getSplitState } = await import('../../split/state');
  const { getSpendingSummary } = await import('../../expense');

  handleSplitCommand(3006);
  const receiptResponse = JSON.stringify({
    merchant: 'Test Cafe',
    items: [{ name: 'Meal', price: 20 }],
    taxAndTip: 0,
    total: 20,
    currency: 'SGD',
  });

  let restore = stubGeminiSequence([receiptResponse]);
  await handleSplitPhoto(3006, userId, Buffer.from('fake jpeg'), 'image/jpeg');
  restore();

  restore = stubGeminiSequence([EVEN_SPLIT_RESPONSE]);
  const breakdownReply = await handleSplitTextMessage(3006, userId, 'split between 2');
  restore();

  assert.match(breakdownReply, /You: S\$10\.00/);
  assert.match(breakdownReply, /Log your share/i);
  assert.equal(getSplitState(3006)?.stage, 'awaiting_log_confirmation');

  const before = await getSpendingSummary(userId, 'today');

  restore = stubGeminiSequence([CATEGORY_RESPONSE]);
  const logReply = await handleSplitTextMessage(3006, userId, 'yes');
  restore();

  assert.match(logReply, /Logged S\$10\.00/);
  assert.equal(getSplitState(3006), undefined);

  const after = await getSpendingSummary(userId, 'today');
  assert.equal(after.total - before.total, 1000); // 10.00 SGD in cents, only the requester's share
  assert.equal(after.count - before.count, 1);
});

test('handleSplitTextMessage: No logs nothing and clears state', async () => {
  const { handleSplitCommand, handleSplitPhoto, handleSplitTextMessage } = await import('./split');
  const { getSplitState } = await import('../../split/state');
  const { getSpendingSummary } = await import('../../expense');

  handleSplitCommand(3007);
  const receiptResponse = JSON.stringify({
    merchant: 'Test Cafe',
    items: [{ name: 'Meal', price: 20 }],
    taxAndTip: 0,
    total: 20,
    currency: 'SGD',
  });

  let restore = stubGeminiSequence([receiptResponse]);
  await handleSplitPhoto(3007, userId, Buffer.from('fake jpeg'), 'image/jpeg');
  restore();

  restore = stubGeminiSequence([EVEN_SPLIT_RESPONSE]);
  await handleSplitTextMessage(3007, userId, 'split between 2');
  restore();

  const before = await getSpendingSummary(userId, 'today');
  const reply = await handleSplitTextMessage(3007, userId, 'no');
  const after = await getSpendingSummary(userId, 'today');

  assert.match(reply, /nothing logged/i);
  assert.equal(getSplitState(3007), undefined);
  assert.equal(after.total, before.total);
  assert.equal(after.count, before.count);
});

test('handleSplitTextMessage asks for clarification when the requester share is ambiguous, without advancing the stage', async () => {
  // Note: this only applies to itemized mode. calculateEvenSplit always
  // treats the first share ("You") as the requester by construction, so an
  // even split can never produce a null requesterShare — see calculator.ts.
  const { handleSplitCommand, handleSplitPhoto, handleSplitTextMessage } = await import('./split');
  const { getSplitState } = await import('../../split/state');

  handleSplitCommand(3008);
  const receiptResponse = JSON.stringify({
    merchant: 'Test Cafe',
    items: [{ name: 'Meal', price: 20 }],
    taxAndTip: 0,
    total: 20,
    currency: 'SGD',
  });

  let restore = stubGeminiSequence([receiptResponse]);
  await handleSplitPhoto(3008, userId, Buffer.from('fake jpeg'), 'image/jpeg');
  restore();

  const ambiguousResponse = JSON.stringify({
    mode: 'itemized',
    itemAssignments: [{ itemName: 'Meal', personLabels: ['Alice'] }],
    requesterLabel: null,
  });
  restore = stubGeminiSequence([ambiguousResponse]);

  try {
    const reply = await handleSplitTextMessage(3008, userId, 'Alice had the meal');
    assert.match(reply, /which share is yours/i);
    assert.equal(getSplitState(3008)?.stage, 'awaiting_instructions');
  } finally {
    restore();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/bot/commands/split.test.ts`
Expected: FAIL — `handleSplitPhoto`/`handleSplitTextMessage` don't accept a `userId` argument yet.

- [ ] **Step 3: Update `src/split/extraction.ts`**

Replace the imports and the `extractReceipt` function:

```typescript
import { getProviderForUser } from '../llm/provider';
import { findById } from '../users/service';
import { Currency } from '../types';
import { ExtractedReceipt, ReceiptItem } from './types';

// ... ExtractionError, VALID_CURRENCIES, round2, SYSTEM_INSTRUCTION, parseGeminiReceiptResponse unchanged ...

export async function extractReceipt(userId: string, photoBuffer: Buffer, mimeType: string): Promise<ExtractedReceipt> {
  try {
    const user = await findById(userId);
    if (!user) {
      throw new ExtractionError(`No user found with id ${userId}`);
    }
    const provider = getProviderForUser(user);

    // Vision calls run slower than short text-classification prompts (ai.ts's
    // 15s budget) — 30s gives enough headroom, matching statement-parser.ts.
    const response = await provider.generateText({
      systemInstruction: SYSTEM_INSTRUCTION,
      contents: [
        { inlineData: { mimeType, data: photoBuffer.toString('base64') } },
        { text: 'Extract the receipt as instructed and return only the JSON.' },
      ],
      timeoutMs: 30000,
    });

    return parseGeminiReceiptResponse(response);
  } catch (error) {
    if (error instanceof ExtractionError) {
      throw error;
    }
    throw new ExtractionError(`Gemini receipt extraction failed: ${(error as Error).message}`);
  }
}
```

(Remove the now-unused `import { GoogleGenerativeAI } from '@google/generative-ai';` and `import { config } from '../config';`.)

- [ ] **Step 4: Update `src/split/assignment.ts`**

Replace the imports and the `parseSplitInstructions` function:

```typescript
import { getProviderForUser } from '../llm/provider';
import { findById } from '../users/service';
import { ItemAssignment, ReceiptItem, SplitInstructions } from './types';

// ... AssignmentParseError, buildSystemInstruction, parseGeminiAssignmentResponse unchanged ...

export async function parseSplitInstructions(
  userId: string,
  freeText: string,
  items: ReceiptItem[],
): Promise<SplitInstructions> {
  try {
    const user = await findById(userId);
    if (!user) {
      throw new AssignmentParseError(`No user found with id ${userId}`);
    }
    const provider = getProviderForUser(user);

    const response = await provider.generateText({
      systemInstruction: buildSystemInstruction(items),
      contents: [{ text: `User's message: "${freeText}"\n\nReturn only the JSON.` }],
      timeoutMs: 15000,
    });

    return parseGeminiAssignmentResponse(
      response,
      items.map((item) => item.name),
    );
  } catch (error) {
    if (error instanceof AssignmentParseError) {
      throw error;
    }
    throw new AssignmentParseError(`Gemini split instruction parsing failed: ${(error as Error).message}`);
  }
}
```

(Remove the now-unused `import { GoogleGenerativeAI } from '@google/generative-ai';` and `import { config } from '../config';`.)

- [ ] **Step 5: Update `src/bot/commands/split.ts`**

Change the three orchestration function signatures and their internal calls:

```typescript
export async function handleSplitPhoto(chatId: number, userId: string, photoBuffer: Buffer, mimeType: string): Promise<string> {
  const state = getSplitState(chatId);
  if (!state || state.stage !== 'awaiting_photo') {
    return 'Got a photo — if you want to split a bill, run /split first.';
  }

  try {
    const receipt = await extractReceipt(userId, photoBuffer, mimeType);
    setReceipt(chatId, receipt);
    return `Got it${receipt.merchant ? ` — ${receipt.merchant}` : ''}. Should I split it evenly, or tell me who had what?`;
  } catch (error) {
    if (error instanceof ExtractionError) {
      logger.warn('Receipt extraction failed', { message: error.message });
      return `I couldn't read that receipt (${error.message}). Try a clearer photo.`;
    }
    throw error;
  }
}

export async function handleSplitTextMessage(chatId: number, userId: string, message: string): Promise<string> {
  const state = getSplitState(chatId);
  if (!state) {
    throw new Error(`handleSplitTextMessage called with no active split for chat ${chatId}`);
  }

  if (state.stage === 'awaiting_photo') {
    return 'Still waiting on a photo of the receipt — send one, or /cancel to stop.';
  }

  if (state.stage === 'awaiting_instructions') {
    if (!state.receipt) {
      throw new Error(`Split for chat ${chatId} is awaiting_instructions with no receipt`);
    }
    const receipt = state.receipt;

    try {
      const instructions = await parseSplitInstructions(userId, message, receipt.items);
      const result =
        instructions.mode === 'even'
          ? calculateEvenSplit(receipt.total, instructions.headcount!)
          : calculateItemizedSplit(
              receipt.items,
              receipt.taxAndTip,
              instructions.itemAssignments!,
              instructions.requesterLabel,
            );

      if (!result.requesterShare) {
        return 'I couldn\'t tell which share is yours — mention yourself as "I" or "me" and try again.';
      }

      setPendingResult(chatId, result);
      const breakdown = formatBreakdown(result, receipt.currency);
      const shareCents = Math.round(result.requesterShare.total * 100);
      return `${breakdown}\n\nLog your share of ${formatCurrency(
        shareCents,
        receipt.currency,
      )} as an expense? (skip if it's already logged some other way, e.g. Apple Pay) Yes/No`;
    } catch (error) {
      if (error instanceof AssignmentParseError) {
        logger.warn('Split instruction parsing failed', { message: error.message });
        return `I couldn't work that out (${error.message}). Try again — e.g. "split between 3" or "Alice had the burger, I had the salad".`;
      }
      throw error;
    }
  }

  if (state.stage === 'awaiting_log_confirmation') {
    const confirmed = /^\s*y(es)?\s*$/i.test(message);
    const declined = /^\s*no?\s*$/i.test(message);

    if (!confirmed && !declined) {
      return 'Reply Yes to log your share, or No to skip.';
    }

    const pendingResult = state.pendingResult;
    if (!pendingResult || !pendingResult.requesterShare) {
      throw new Error(`Split for chat ${chatId} is awaiting_log_confirmation with no pending result`);
    }
    const receipt = state.receipt;

    if (declined) {
      clearSplit(chatId);
      return 'Okay, nothing logged.';
    }

    const merchant = receipt?.merchant ?? 'Split bill';
    const transaction = await logExpense(userId, {
      amount: pendingResult.requesterShare.total,
      currency: receipt?.currency,
      merchant,
      note: 'Split bill',
      source: 'split',
    });

    clearSplit(chatId);

    return `Logged ${formatCurrency(transaction.amount_sgd, 'SGD')} for ${transaction.merchant} (${transaction.category}).`;
  }

  throw new Error(`Unexpected split stage "${state.stage}" for chat ${chatId}`);
}
```

(`handleSplitCommand`/`handleCancelCommand`/`formatBreakdown` above these two functions are unchanged.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx --test src/bot/commands/split.test.ts`
Expected: PASS (9/9).

- [ ] **Step 7: Commit**

```bash
git add src/split/extraction.ts src/split/assignment.ts src/bot/commands/split.ts src/bot/commands/split.test.ts
git commit -m "feat(split): route extractReceipt and parseSplitInstructions through getProviderForUser"
```

---

### Task 17: `buildAssistantReply` takes `userId`

**Files:**
- Modify: `src/bot/ai.ts` (`buildAssistantReply` only)
- Modify: `src/bot/ai.test.ts` (every `buildAssistantReply` test)
- Modify: `src/bot/handlers/text.ts`

**Interfaces:**
- Produces: `buildAssistantReply(userId: string, result: IntentAnalysis, source: ExpenseSource = 'text'): Promise<string>`, `handleTextMessage(userId: string, message: string): Promise<string>`

Note: this makes `src/bot/handlers/voice.ts` fail to typecheck (it still calls the old two-argument shape) — that's fixed in Task 21, not this one. Don't touch `voice.ts` here.

- [ ] **Step 1: Update every `buildAssistantReply` test in `src/bot/ai.test.ts` (RED)**

The file after Task 13 has a shared `userId` from its `before()` hook. Replace every remaining test in the file (everything below the two `classifyUserMessage` tests Task 13 already updated) with:

```typescript
test('buildAssistantReply logs a real expense transaction for the expense intent', async () => {
  const { stubGeminiCategorization } = await import('../testing/geminiStub');
  const restoreGemini = stubGeminiCategorization();

  try {
    const { buildAssistantReply } = await import('./ai');
    const reply = await buildAssistantReply(userId, {
      intent: 'expense',
      confidence: 0.96,
      extracted: {
        amount: 4.5,
        merchant: 'Ya Kun',
        category: 'Food',
      },
      rawText: 'Spent $4.50 at Ya Kun',
    });

    assert.match(reply, /4\.50/i);
    assert.match(reply, /Ya Kun/i);

    const { getTopExpenses } = await import('../expense/service');
    const [logged] = await getTopExpenses(userId, 'today', 1);
    assert.ok(logged);
    assert.equal(logged.merchant, 'Ya Kun');
    assert.equal(logged.amount, 450);
    assert.equal(logged.source, 'text');
  } finally {
    restoreGemini();
  }
});

test('buildAssistantReply asks for an amount when the expense intent has none', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'expense',
    confidence: 0.4,
    extracted: { merchant: 'Ya Kun' },
    rawText: 'bought something at Ya Kun',
  });

  assert.match(reply, /how much/i);
});

test('buildAssistantReply returns the generic error message when Gemini failed, not a guessed intent', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'unknown',
    confidence: 0,
    extracted: {},
    rawText: 'Spent $4.50 at Ya Kun',
    serviceError: true,
  });

  assert.match(reply, /hiccupped/i);
});

test('buildAssistantReply sets a real budget for the budget intent', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'budget',
    confidence: 0.9,
    extracted: { category: 'Food', budgetAmount: 800 },
    rawText: 'Set food budget to $800/month',
  });

  assert.match(reply, /Food/);
  assert.match(reply, /800\.00/);

  const { findBudgetByCategory } = await import('../budget/service');
  const budget = await findBudgetByCategory(userId, 'Food');
  assert.ok(budget);
  assert.equal(budget!.amount_sgd, 80000);
});

test('buildAssistantReply removes a budget when the action indicates removal', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { setBudget, findBudgetByCategory } = await import('../budget/service');
  await setBudget(userId, 'Travel', 200, 'SGD');

  const reply = await buildAssistantReply(userId, {
    intent: 'budget',
    confidence: 0.9,
    extracted: { category: 'Travel', action: 'remove' },
    rawText: 'Remove my travel budget',
  });

  assert.match(reply, /removed/i);
  assert.match(reply, /Travel/);

  const budget = await findBudgetByCategory(userId, 'Travel');
  assert.equal(budget, null);
});

test('buildAssistantReply asks for a category when the budget intent has none', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'budget',
    confidence: 0.5,
    extracted: {},
    rawText: 'set a budget',
  });

  assert.match(reply, /which category/i);
});

test('buildAssistantReply records a new crypto holding for the holdings intent', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'BTC', amount: 0.5, assetClass: 'crypto', currency: 'USD' },
    rawText: 'I hold 0.5 BTC',
  });

  assert.match(reply, /BTC/);

  const { listHoldings } = await import('../portfolio/service');
  const allHoldings = await listHoldings(userId);
  const btc = allHoldings.find((h) => h.symbol === 'BTC');

  assert.ok(btc);
  assert.equal(btc!.quantity, 0.5);
  assert.equal(btc!.broker, null);
});

test('buildAssistantReply removes a holding when the action indicates removal', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { addHolding, listHoldings } = await import('../portfolio/service');
  await addHolding(userId, { symbol: 'ETH', name: 'ETH', quantity: 1, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });

  const reply = await buildAssistantReply(userId, {
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'ETH', action: 'remove' },
    rawText: 'Remove my ETH holding',
  });

  assert.match(reply, /removed/i);

  const allHoldings = await listHoldings(userId);
  assert.ok(!allHoldings.some((h) => h.symbol === 'ETH'));
});

test('buildAssistantReply falls back to crypto when the holdings intent has an unrecognized asset class', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'AAPL', amount: 10, assetClass: 'stocks_us', currency: 'USD' },
    rawText: 'I hold 10 AAPL',
  });

  assert.match(reply, /AAPL/);

  const { listHoldings } = await import('../portfolio/service');
  const allHoldings = await listHoldings(userId);
  const aapl = allHoldings.find((h) => h.symbol === 'AAPL');

  assert.ok(aapl);
  assert.equal(aapl!.asset_class, 'crypto');
});

test('buildAssistantReply falls back to USD when the holdings intent has an unrecognized currency', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'DOGE', amount: 100, assetClass: 'crypto', currency: 'HKD' },
    rawText: 'I hold 100 DOGE',
  });

  assert.match(reply, /DOGE/);

  const { listHoldings } = await import('../portfolio/service');
  const allHoldings = await listHoldings(userId);
  const doge = allHoldings.find((h) => h.symbol === 'DOGE');

  assert.ok(doge);
  assert.equal(doge!.currency, 'USD');
});

test('buildAssistantReply asks which holding when the holdings intent has no symbol', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'holdings',
    confidence: 0.5,
    extracted: {},
    rawText: 'I have some crypto',
  });

  assert.match(reply, /which holding/i);
});

test('buildAssistantReply answers a query intent with real spending data', async () => {
  const { stubGeminiCategorization } = await import('../testing/geminiStub');
  const restoreGemini = stubGeminiCategorization();

  try {
    const { getSpendingSummary, logExpense } = await import('../expense/service');
    const before = await getSpendingSummary(userId, 'today');

    await logExpense(userId, { amount: 10, merchant: 'Fairprice', source: 'text' });

    const { buildAssistantReply } = await import('./ai');
    const reply = await buildAssistantReply(userId, {
      intent: 'query',
      confidence: 0.8,
      extracted: { period: 'today' },
      rawText: 'How much did I spend today?',
    });

    const after = await getSpendingSummary(userId, 'today');
    assert.equal(after.count, before.count + 1);
    assert.match(reply, new RegExp(`${(after.total / 100).toFixed(2)}`));
    assert.match(reply, new RegExp(String(after.count)));
  } finally {
    restoreGemini();
  }
});

test('buildAssistantReply falls back to a month query when period is not recognized', async () => {
  const { getSpendingSummary } = await import('../expense/service');
  const { buildAssistantReply } = await import('./ai');
  const monthSummary = await getSpendingSummary(userId, 'month');

  const reply = await buildAssistantReply(userId, {
    intent: 'query',
    confidence: 0.5,
    extracted: { period: 'this year' },
    rawText: 'how much have I spent',
  });

  assert.match(reply, new RegExp(`${(monthSummary.total / 100).toFixed(2)}`));
});

test('buildAssistantReply creates a real recurring transaction for the recurring intent', async () => {
  const { stubGeminiCategorization } = await import('../testing/geminiStub');
  const restoreGemini = stubGeminiCategorization();

  try {
    const { buildAssistantReply } = await import('./ai');
    const reply = await buildAssistantReply(userId, {
      intent: 'recurring',
      confidence: 0.9,
      extracted: { amount: 15.98, merchant: 'Netflix', dayOfMonth: 5 },
      rawText: 'Netflix $15.98 every 5th',
    });

    assert.match(reply, /Netflix/i);
    assert.match(reply, /5/);

    const { listRecurring } = await import('../expense/service');
    const all = await listRecurring(userId);
    const netflix = all.find((r) => r.merchant === 'Netflix');

    assert.ok(netflix);
    assert.equal(netflix.amount, 1598);
    assert.equal(netflix.day_of_month, 5);
  } finally {
    restoreGemini();
  }
});

test('buildAssistantReply asks for a day of month when the recurring intent has none', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'recurring',
    confidence: 0.6,
    extracted: { amount: 15.98, merchant: 'Netflix' },
    rawText: 'Netflix $15.98 monthly',
  });

  assert.match(reply, /which day|day of the month/i);
});

test('buildAssistantReply asks which merchant when the recurring intent has none', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'recurring',
    confidence: 0.5,
    extracted: {},
    rawText: 'set up a recurring payment',
  });

  assert.match(reply, /which (merchant|subscription|recurring)/i);
});

test('buildAssistantReply removes a recurring transaction matched by merchant', async () => {
  const { stubGeminiCategorization } = await import('../testing/geminiStub');
  const restoreGemini = stubGeminiCategorization();

  try {
    const { createRecurring, listRecurring } = await import('../expense/service');
    await createRecurring(userId, { amount: 9.9, merchant: 'Spotify', day_of_month: 1 });

    const { buildAssistantReply } = await import('./ai');
    const reply = await buildAssistantReply(userId, {
      intent: 'recurring',
      confidence: 0.9,
      extracted: { merchant: 'Spotify', action: 'remove' },
      rawText: 'Cancel my Spotify subscription',
    });

    assert.match(reply, /removed/i);
    assert.match(reply, /Spotify/i);

    const all = await listRecurring(userId);
    assert.ok(!all.some((r) => r.merchant === 'Spotify'));
  } finally {
    restoreGemini();
  }
});

test('buildAssistantReply tells the user when no matching recurring entry is found to remove', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'recurring',
    confidence: 0.7,
    extracted: { merchant: 'NonexistentThing', action: 'remove' },
    rawText: 'cancel NonexistentThing',
  });

  assert.match(reply, /couldn.?t find/i);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/bot/ai.test.ts`
Expected: FAIL on every `buildAssistantReply` test (extra `userId` argument doesn't match the current signature) — the two `classifyUserMessage` tests from Task 13 still pass.

- [ ] **Step 3: Update `buildAssistantReply` in `src/bot/ai.ts`**

Change the function signature and thread `userId` into every case's service calls:

```typescript
export async function buildAssistantReply(
  userId: string,
  result: IntentAnalysis,
  source: ExpenseSource = 'text',
): Promise<string> {
  const { intent, extracted, rawText, serviceError } = result;

  if (serviceError) {
    return formatUserFriendlyError();
  }

  switch (intent) {
    case 'expense': {
      const { logExpense } = await import('../expense/service');

      const amount = extracted.amount ?? 0;
      if (amount <= 0) {
        return `How much did you spend? Try "Spent $4.50 at Ya Kun".`;
      }

      const currency: Currency | undefined = VALID_CURRENCIES.has(extracted.currency ?? '')
        ? (extracted.currency as Currency)
        : undefined;

      const transaction = await logExpense(userId, {
        amount,
        currency,
        merchant: extracted.merchant,
        source,
      });

      return `Logged S$${(transaction.amount_sgd / 100).toFixed(2)} at ${transaction.merchant} under ${transaction.category}.`;
    }
    case 'budget': {
      const { setBudget, removeBudget } = await import('../budget/service');
      const { normalizeCategoryName } = await import('../expense/categorizer');

      if (!extracted.category) {
        return `Sure — which category's budget should I update? Try "Set food budget to $800/month".`;
      }

      const category = normalizeCategoryName(extracted.category);
      const isRemoval = /remove|delete|cancel/i.test(extracted.action ?? rawText);

      if (isRemoval) {
        await removeBudget(userId, category);
        return `Done — removed the ${category} budget.`;
      }

      const amount = extracted.budgetAmount ?? extracted.amount ?? 0;
      if (amount <= 0) {
        return `What amount should the ${category} budget be? Try "Set food budget to $800/month".`;
      }

      const budget = await setBudget(userId, category, amount);
      return `Got it — ${category} budget set to S$${(budget.amount_sgd / 100).toFixed(2)}/month.`;
    }
    case 'correction': {
      const { correctLastTransaction } = await import('../expense/service');

      let field = 'category';
      let value = extracted.category || rawText;

      if (extracted.merchant) {
        field = 'merchant';
        value = extracted.merchant;
      } else if (extracted.amount) {
        field = 'amount';
        value = extracted.amount.toString();
      } else if (extracted.category) {
        field = 'category';
        value = extracted.category;
      }

      const corrected = await correctLastTransaction(userId, field, value);

      if (!corrected) {
        return `I couldn't find a recent transaction to correct. Try logging an expense first!`;
      }

      return `Updated! Changed ${field} to "${value}" for your last transaction.`;
    }
    case 'recurring': {
      const { createRecurring, listRecurring, removeRecurring } = await import('../expense/service');

      if (!extracted.merchant) {
        return `Which recurring merchant? Try "Netflix $15.98 every 5th" or "cancel my Spotify subscription".`;
      }

      const isRemoval = /remove|delete|cancel|stop/i.test(extracted.action ?? rawText);

      if (isRemoval) {
        const all = await listRecurring(userId);
        const match = all.find((r) => r.merchant.toLowerCase() === extracted.merchant!.toLowerCase());

        if (!match) {
          return `I couldn't find a recurring entry for "${extracted.merchant}".`;
        }

        await removeRecurring(userId, match.id);
        return `Done — removed the recurring ${match.merchant} charge.`;
      }

      const amount = extracted.amount ?? 0;
      if (amount <= 0) {
        return `How much is the ${extracted.merchant} charge?`;
      }

      const dayOfMonth = extracted.dayOfMonth;
      if (!dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31) {
        return `Which day of the month does ${extracted.merchant} charge you?`;
      }

      const currency: Currency | undefined = VALID_CURRENCIES.has(extracted.currency ?? '')
        ? (extracted.currency as Currency)
        : undefined;

      const recurring = await createRecurring(userId, {
        amount,
        currency,
        merchant: extracted.merchant,
        day_of_month: dayOfMonth,
      });

      return `Got it — I'll log $${amount.toFixed(2)} at ${recurring.merchant} every month on day ${recurring.day_of_month}.`;
    }
    case 'holdings': {
      const { addHolding, removeHolding } = await import('../portfolio/service');

      if (!extracted.symbol) {
        return `Which holding? Try "I hold 0.5 BTC" or "cash SGD 5000".`;
      }

      const symbol = extracted.symbol.toUpperCase();
      const isRemoval = /remove|delete/i.test(extracted.action ?? rawText);

      if (isRemoval) {
        await removeHolding(userId, symbol);
        return `Done — removed ${symbol} from your holdings.`;
      }

      const quantity = extracted.amount ?? 0;
      if (quantity <= 0) {
        return `How much ${symbol} do you hold?`;
      }

      const assetClass: AssetClass = VALID_HOLDINGS_ASSET_CLASSES.has(extracted.assetClass ?? '')
        ? (extracted.assetClass as AssetClass)
        : 'crypto';
      const currency: Currency = VALID_CURRENCIES.has(extracted.currency ?? '')
        ? (extracted.currency as Currency)
        : 'USD';

      const holding = await addHolding(userId, {
        symbol,
        name: symbol,
        quantity,
        asset_class: assetClass,
        currency,
        market: assetClass === 'cash' ? 'Cash' : 'Crypto',
      });

      return `Got it — recorded ${holding.quantity} ${holding.symbol}.`;
    }
    case 'query': {
      const { getSpendingSummary } = await import('../expense/service');
      const { formatSpendingSummary } = await import('./formatter/messages');

      const period: SpendingPeriod = VALID_SPENDING_PERIODS.has(extracted.period ?? '')
        ? (extracted.period as SpendingPeriod)
        : 'month';

      const summary = await getSpendingSummary(userId, period);
      const label = period === 'today' ? "Today's spend" : period === 'week' ? "This week's spend" : "This month's spend";

      return formatSpendingSummary(label, summary);
    }
    case 'help': {
      return `Here's what I can do: /portfolio, /today, /month, /budget, /export, /undo, /help. You can also just message me naturally.`;
    }
    default:
      return `I'm not totally sure what you mean there, but I'm happy to help. Try /help or send something like "Spent $4.50 at Ya Kun".`;
  }
}
```

- [ ] **Step 4: Update `src/bot/handlers/text.ts`**

```typescript
/**
 * Free-text message processing for Telegram bot
 */

import { logger } from '../../utils/logger';
import { buildAssistantReply, classifyUserMessage } from '../ai';

export async function classifyIntent(userId: string, message: string): Promise<{ intent: string; confidence: number; text: string }> {
  const result = await classifyUserMessage(userId, message);
  return {
    intent: result.intent,
    confidence: result.confidence,
    text: result.rawText,
  };
}

export async function handleTextMessage(userId: string, message: string): Promise<string> {
  const classification = await classifyUserMessage(userId, message);
  logger.debug('Classified Telegram message', {
    intent: classification.intent,
    confidence: classification.confidence,
    rawText: classification.rawText,
  });

  return await buildAssistantReply(userId, classification);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test src/bot/ai.test.ts`
Expected: 20 total, 19 passing, 1 skipped (the opt-in live Gemini call test).

- [ ] **Step 6: Commit**

```bash
git add src/bot/ai.ts src/bot/ai.test.ts src/bot/handlers/text.ts
git commit -m "feat(bot): thread userId through buildAssistantReply and handleTextMessage"
```

---

### Task 18: `BotContext` + rewrite `authMiddleware`

**Files:**
- Create: `src/bot/context.ts`
- Modify: `src/bot/middleware/auth.ts`
- Create: `src/bot/middleware/auth.test.ts`
- Modify: `package.json` (add `src/bot/middleware/auth.test.ts`)

**Interfaces:**
- Consumes: `findByChatId` (Task 4), `User` (Task 4)
- Produces: `BotContext` (Grammy `Context` + `user?: User`), `authMiddleware(ctx: BotContext, next: Next): Promise<void>` (rewritten)

- [ ] **Step 1: Write `src/bot/context.ts`**

```typescript
/**
 * Grammy context extended with the resolved users row, attached by
 * authMiddleware once a chat_id maps to a known user.
 */

import { Context } from 'grammy';
import { User } from '../users/types';

export interface BotContext extends Context {
  user?: User;
}
```

- [ ] **Step 2: Write the failing tests**

Create `src/bot/middleware/auth.test.ts`:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-bot-auth.db';

const testDbPath = path.resolve('./data/test-bot-auth.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  runMigrations();
});

function fakeCtx(chatId: number, text?: string) {
  const replies: string[] = [];
  const ctx: any = {
    chat: { id: chatId },
    message: text !== undefined ? { text } : undefined,
    reply: async (msg: string) => {
      replies.push(msg);
    },
  };
  return { ctx, replies };
}

test('authMiddleware blocks an unregistered chat sending a non-setup message', async () => {
  const { authMiddleware } = await import('./auth');
  const { ctx, replies } = fakeCtx(9001, 'Spent $4.50 at Ya Kun');
  let nextCalled = false;

  await authMiddleware(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.match(replies[0], /run \/setup/i);
  assert.equal(ctx.user, undefined);
});

test('authMiddleware lets an unregistered chat through for /setup', async () => {
  const { authMiddleware } = await import('./auth');
  const { ctx } = fakeCtx(9002, '/setup');
  let nextCalled = false;

  await authMiddleware(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});

test('authMiddleware lets an unregistered chat through for /help', async () => {
  const { authMiddleware } = await import('./auth');
  const { ctx } = fakeCtx(9003, '/help');
  let nextCalled = false;

  await authMiddleware(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});

test('authMiddleware blocks a pending-approval user sending a non-setup message', async () => {
  const { createUser, setProvider, completeSetup } = await import('../../users/service');
  const { encrypt } = await import('../../users/crypto');
  const user = await createUser('9004');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key'), false); // isAdmin=false -> pending_approval

  const { authMiddleware } = await import('./auth');
  const { ctx, replies } = fakeCtx(9004, 'How much did I spend?');
  let nextCalled = false;

  await authMiddleware(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.match(replies[0], /admin approval/i);
});

test('authMiddleware attaches the user and calls next for an onboarding chat', async () => {
  const { createUser } = await import('../../users/service');
  await createUser('9005');

  const { authMiddleware } = await import('./auth');
  const { ctx } = fakeCtx(9005, 'gemini');
  let nextCalled = false;

  await authMiddleware(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.ok(ctx.user);
  assert.equal(ctx.user.status, 'onboarding');
});

test('authMiddleware attaches the user and calls next for an approved chat', async () => {
  const { createUser, approve } = await import('../../users/service');
  const user = await createUser('9006');
  await approve(user.id);

  const { authMiddleware } = await import('./auth');
  const { ctx } = fakeCtx(9006, 'Spent $4.50 at Ya Kun');
  let nextCalled = false;

  await authMiddleware(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(ctx.user!.status, 'approved');
});
```

- [ ] **Step 3: Add `src/bot/middleware/auth.test.ts` to `package.json`'s test script**

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx tsx --test src/bot/middleware/auth.test.ts`
Expected: FAIL — the current `authMiddleware` only checks `TELEGRAM_AUTHORIZED_CHAT_ID`, it never rejects with "Run /setup" or attaches `ctx.user`.

- [ ] **Step 5: Rewrite `src/bot/middleware/auth.ts`**

```typescript
/**
 * Resolves the calling chat's users row and gates access by status.
 * Unregistered and pending-approval chats can only reach /setup and /help.
 */

import { Next } from 'grammy';
import { findByChatId } from '../../users/service';
import { BotContext } from '../context';

export async function authMiddleware(ctx: BotContext, next: Next): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    await next();
    return;
  }

  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : undefined;
  const isSetupOrHelp = Boolean(text && /^\/(setup|help)(\s|$)/.test(text));

  const user = await findByChatId(String(chatId));

  if (!user || user.status === 'pending_approval') {
    if (isSetupOrHelp) {
      if (user) {
        ctx.user = user;
      }
      await next();
      return;
    }
    await ctx.reply(user ? 'Still waiting on admin approval — hang tight!' : 'Run /setup to get started.');
    return;
  }

  ctx.user = user;
  await next();
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx --test src/bot/middleware/auth.test.ts`
Expected: PASS (6/6).

- [ ] **Step 7: Commit**

```bash
git add src/bot/context.ts src/bot/middleware/auth.ts src/bot/middleware/auth.test.ts package.json
git commit -m "feat(bot): rewrite authMiddleware to resolve and gate by users row status"
```

---

### Task 19: `/setup` flow

Adds one small function to `users/service.ts` (`restartOnboarding`) that Task 4 didn't anticipate needing — re-running `/setup` on an already-approved user must reset both `status` back to `'onboarding'` *and* `llm_provider` back to `null` (so the next message is treated as a fresh provider pick, not an API key), which `setProvider`/`completeSetup` alone don't cover.

**Files:**
- Modify: `src/users/service.ts` (add `restartOnboarding`)
- Modify: `src/users/service.test.ts` (one new test)
- Create: `src/bot/commands/setup.ts`
- Create: `src/bot/commands/setup.test.ts`
- Modify: `package.json` (add `src/bot/commands/setup.test.ts`)

**Interfaces:**
- Consumes: `createUser`, `findByChatId`, `setProvider`, `completeSetup` (Task 4), `encrypt` (Task 3), `GeminiProvider` (Task 5)
- Produces: `restartOnboarding(userId: string): Promise<User>`; `handleSetupCommand(telegramChatId: string): Promise<string>`; `SetupTextResult { reply: string; notifyAdminForChatId?: string }`; `handleSetupTextMessage(user: User, text: string): Promise<SetupTextResult>`

Note: `setup.ts`'s functions are pure (no Grammy `Context`) — consistent with how `bot/commands/split.ts` is written. Sending the admin DM and best-effort-deleting the user's key message both need bot API access, so they're wired in `bot/index.ts` (Task 22) based on `SetupTextResult.notifyAdminForChatId`, not here.

- [ ] **Step 1: Add the failing `restartOnboarding` test to `src/users/service.test.ts`**

Append:

```typescript
test('restartOnboarding resets status to onboarding and clears the chosen provider', async () => {
  const { createUser, approve, setProvider, restartOnboarding } = await import('./service');
  const user = await createUser('chat-restart-onboarding');
  await setProvider(user.id, 'gemini');
  await approve(user.id);

  const restarted = await restartOnboarding(user.id);
  assert.equal(restarted.status, 'onboarding');
  assert.equal(restarted.llm_provider, null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/users/service.test.ts`
Expected: FAIL — `restartOnboarding` doesn't exist yet (12 pass, 1 fails).

- [ ] **Step 3: Add `restartOnboarding` to `src/users/service.ts`**

Append after `setProvider`:

```typescript
/** Resets an already-configured user back to the start of onboarding — used when re-running /setup. */
export async function restartOnboarding(userId: string): Promise<User> {
  const [updated] = await db
    .update(users)
    .set({ status: 'onboarding', llm_provider: null, updated_at: Date.now() })
    .where(eq(users.id, userId))
    .returning();
  if (!updated) {
    throw new Error(`No user found with id ${userId}`);
  }
  return mapUserRow(updated);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/users/service.test.ts`
Expected: PASS (13/13).

- [ ] **Step 5: Write the failing tests for the `/setup` flow**

Create `src/bot/commands/setup.test.ts`:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-bot-setup.db';
process.env.ADMIN_CHAT_ID = 'admin-chat-id';

const testDbPath = path.resolve('./data/test-bot-setup.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  runMigrations();
});

function geminiRestResponse(text: string): Response {
  const body = JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

test('handleSetupCommand creates a new user and asks which provider', async () => {
  const { handleSetupCommand } = await import('./setup');
  const reply = await handleSetupCommand('chat-new-1');

  assert.match(reply, /which llm provider/i);

  const { findByChatId } = await import('../../users/service');
  const user = await findByChatId('chat-new-1');
  assert.ok(user);
  assert.equal(user!.status, 'onboarding');
});

test('handleSetupCommand restarts onboarding for an already-approved user', async () => {
  const { createUser, approve, setProvider, findByChatId } = await import('../../users/service');
  const user = await createUser('chat-restart-1');
  await setProvider(user.id, 'gemini');
  await approve(user.id);

  const { handleSetupCommand } = await import('./setup');
  await handleSetupCommand('chat-restart-1');

  const refreshed = await findByChatId('chat-restart-1');
  assert.equal(refreshed!.status, 'onboarding');
  assert.equal(refreshed!.llm_provider, null);
});

test('handleSetupTextMessage rejects an unsupported provider name', async () => {
  const { createUser } = await import('../../users/service');
  const user = await createUser('chat-provider-1');

  const { handleSetupTextMessage } = await import('./setup');
  const result = await handleSetupTextMessage(user, 'openai');

  assert.match(result.reply, /not available yet/i);
});

test('handleSetupTextMessage accepts gemini and asks for an API key', async () => {
  const { createUser, findByChatId } = await import('../../users/service');
  const user = await createUser('chat-provider-2');

  const { handleSetupTextMessage } = await import('./setup');
  const result = await handleSetupTextMessage(user, 'gemini');

  assert.match(result.reply, /api key/i);

  const updated = await findByChatId('chat-provider-2');
  assert.equal(updated!.llm_provider, 'gemini');
});

test('handleSetupTextMessage asks to resend when the key fails validation', async () => {
  const { createUser, setProvider, findByChatId } = await import('../../users/service');
  const user = await createUser('chat-key-fail');
  await setProvider(user.id, 'gemini');
  const refreshed = (await findByChatId('chat-key-fail'))!;

  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated invalid key rejection');
  }) as typeof fetch;

  try {
    const { handleSetupTextMessage } = await import('./setup');
    const result = await handleSetupTextMessage(refreshed, 'bad-key');
    assert.match(result.reply, /didn't work|resend/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleSetupTextMessage on success for a non-admin chat goes to pending_approval and signals an admin notification', async () => {
  const { createUser, setProvider, findByChatId } = await import('../../users/service');
  const user = await createUser('chat-non-admin');
  await setProvider(user.id, 'gemini');
  const refreshed = (await findByChatId('chat-non-admin'))!;

  const originalFetch = global.fetch;
  global.fetch = (async () => geminiRestResponse('OK')) as typeof fetch;

  try {
    const { handleSetupTextMessage } = await import('./setup');
    const result = await handleSetupTextMessage(refreshed, 'a-valid-looking-key');

    assert.match(result.reply, /admin needs to approve/i);
    assert.equal(result.notifyAdminForChatId, 'chat-non-admin');

    const stored = await findByChatId('chat-non-admin');
    assert.equal(stored!.status, 'pending_approval');
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleSetupTextMessage on success for the ADMIN_CHAT_ID auto-approves without notifying anyone', async () => {
  const { createUser, setProvider, findByChatId } = await import('../../users/service');
  const user = await createUser('admin-chat-id');
  await setProvider(user.id, 'gemini');
  const refreshed = (await findByChatId('admin-chat-id'))!;

  const originalFetch = global.fetch;
  global.fetch = (async () => geminiRestResponse('OK')) as typeof fetch;

  try {
    const { handleSetupTextMessage } = await import('./setup');
    const result = await handleSetupTextMessage(refreshed, 'a-valid-looking-key');

    assert.match(result.reply, /auto-approved/i);
    assert.equal(result.notifyAdminForChatId, undefined);

    const stored = await findByChatId('admin-chat-id');
    assert.equal(stored!.status, 'approved');
    assert.equal(stored!.is_admin, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleSetupTextMessage on a key rotation (already approved) re-approves directly without pending_approval', async () => {
  const { createUser, setProvider, completeSetup, approve, findByChatId, restartOnboarding } = await import(
    '../../users/service'
  );
  const { encrypt } = await import('../../users/crypto');
  const user = await createUser('chat-rotate-1');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('first-key'), false);
  await approve(user.id);

  await restartOnboarding(user.id);
  await setProvider(user.id, 'gemini');
  const refreshed = (await findByChatId('chat-rotate-1'))!;

  const originalFetch = global.fetch;
  global.fetch = (async () => geminiRestResponse('OK')) as typeof fetch;

  try {
    const { handleSetupTextMessage } = await import('./setup');
    const result = await handleSetupTextMessage(refreshed, 'second-key');

    assert.match(result.reply, /updated/i);
    assert.equal(result.notifyAdminForChatId, undefined);

    const stored = await findByChatId('chat-rotate-1');
    assert.equal(stored!.status, 'approved');
  } finally {
    global.fetch = originalFetch;
  }
});
```

- [ ] **Step 6: Add `src/bot/commands/setup.test.ts` to `package.json`'s test script**

- [ ] **Step 7: Run the tests to verify they fail**

Run: `npx tsx --test src/bot/commands/setup.test.ts`
Expected: FAIL — `./setup` doesn't exist yet.

- [ ] **Step 8: Write `src/bot/commands/setup.ts`**

```typescript
/**
 * /setup flow: pick a provider (gemini only this slice) -> paste an API key
 * -> live-validate it -> pending admin approval (or auto-approved for
 * ADMIN_CHAT_ID). State lives entirely on the users row — see
 * authMiddleware for how status='onboarding' routes free text here instead
 * of classification.
 */

import { config } from '../../config';
import { encrypt } from '../../users/crypto';
import {
  completeSetup,
  createUser,
  findByChatId,
  restartOnboarding,
  setProvider,
} from '../../users/service';
import { User } from '../../users/types';
import { GeminiProvider } from '../../llm/gemini';

const SUPPORTED_PROVIDERS = new Set(['gemini']);

export interface SetupTextResult {
  reply: string;
  /** Set when a non-admin chat just completed setup and needs admin approval. */
  notifyAdminForChatId?: string;
}

export async function handleSetupCommand(telegramChatId: string): Promise<string> {
  const existing = await findByChatId(telegramChatId);

  if (!existing) {
    await createUser(telegramChatId);
  } else {
    await restartOnboarding(existing.id);
  }

  return 'Welcome to Pluto AI! Which LLM provider would you like to use? Reply with: gemini';
}

async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    await new GeminiProvider(apiKey).generateText({
      systemInstruction: 'You are a health check.',
      contents: [{ text: 'Reply with OK.' }],
      timeoutMs: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function handleSetupTextMessage(user: User, text: string): Promise<SetupTextResult> {
  const trimmed = text.trim();

  if (!user.llm_provider) {
    const providerName = trimmed.toLowerCase();
    if (!SUPPORTED_PROVIDERS.has(providerName)) {
      return { reply: `That provider isn't available yet — reply "gemini" for now.` };
    }
    await setProvider(user.id, 'gemini');
    return {
      reply:
        "Got it — now send me your Gemini API key (get one at https://aistudio.google.com/apikey). I'll delete your message right after.",
    };
  }

  const isValid = await validateApiKey(trimmed);
  if (!isValid) {
    return { reply: "That key didn't work — the provider rejected it. Please resend a valid API key." };
  }

  const isAdmin = config.ADMIN_CHAT_ID !== undefined && user.telegram_chat_id === config.ADMIN_CHAT_ID;
  const wasAlreadyApproved = user.llm_api_key_encrypted !== null; // rotation, not a first-time signup
  const completed = await completeSetup(user.id, encrypt(trimmed), isAdmin);

  if (completed.status === 'pending_approval') {
    return {
      reply: "Thanks! Your key checks out. An admin needs to approve your account before you can use the bot — I'll let you know.",
      notifyAdminForChatId: user.telegram_chat_id,
    };
  }

  return {
    reply: wasAlreadyApproved ? "Key updated — you're all set." : "You're auto-approved as the admin. You're all set — try /help.",
  };
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx tsx --test src/bot/commands/setup.test.ts`
Expected: PASS (8/8).

- [ ] **Step 10: Commit**

```bash
git add src/users/service.ts src/users/service.test.ts src/bot/commands/setup.ts src/bot/commands/setup.test.ts package.json
git commit -m "feat(bot): add the /setup onboarding flow"
```

---

### Task 20: `/approve` and `/reject` (admin-only)

Same pattern as `setup.ts`: pure functions that return what to reply *and* what (if anything) to notify the affected user of, leaving the actual `bot.api.sendMessage` call to `bot/index.ts` (Task 22).

**Files:**
- Create: `src/bot/commands/approve.ts`
- Create: `src/bot/commands/approve.test.ts`
- Modify: `package.json` (add `src/bot/commands/approve.test.ts`)

**Interfaces:**
- Consumes: `findByChatId`, `approve`, `reject` (Task 4)
- Produces: `AdminActionResult { reply: string; notifyChatId?: string; notifyMessage?: string }`; `handleApproveCommand(caller: User, targetChatId: string): Promise<AdminActionResult>`; `handleRejectCommand(caller: User, targetChatId: string): Promise<AdminActionResult>`

- [ ] **Step 1: Write the failing tests**

Create `src/bot/commands/approve.test.ts`:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-bot-approve.db';

const testDbPath = path.resolve('./data/test-bot-approve.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  runMigrations();
});

test('handleApproveCommand refuses a non-admin caller', async () => {
  const { createUser } = await import('../../users/service');
  const nonAdmin = await createUser('chat-caller-1');

  const { handleApproveCommand } = await import('./approve');
  const result = await handleApproveCommand(nonAdmin, 'chat-target-1');

  assert.match(result.reply, /only the admin/i);
  assert.equal(result.notifyChatId, undefined);
});

test('handleApproveCommand asks for usage when no chat id is given', async () => {
  const { createUser, approve } = await import('../../users/service');
  const admin = await createUser('chat-admin-1');
  await approve(admin.id);

  const { handleApproveCommand } = await import('./approve');
  const result = await handleApproveCommand({ ...admin, is_admin: true }, '');

  assert.match(result.reply, /usage/i);
});

test('handleApproveCommand reports when no user exists for that chat', async () => {
  const { createUser } = await import('../../users/service');
  const admin = await createUser('chat-admin-2');

  const { handleApproveCommand } = await import('./approve');
  const result = await handleApproveCommand({ ...admin, is_admin: true }, 'nonexistent-chat');

  assert.match(result.reply, /no pending user/i);
});

test('handleApproveCommand approves a pending user and signals notifying them', async () => {
  const { createUser, setProvider, completeSetup, findByChatId } = await import('../../users/service');
  const { encrypt } = await import('../../users/crypto');
  const admin = await createUser('chat-admin-3');
  const pending = await createUser('chat-pending-1');
  await setProvider(pending.id, 'gemini');
  await completeSetup(pending.id, encrypt('some-key'), false);

  const { handleApproveCommand } = await import('./approve');
  const result = await handleApproveCommand({ ...admin, is_admin: true }, 'chat-pending-1');

  assert.match(result.reply, /approved/i);
  assert.equal(result.notifyChatId, 'chat-pending-1');
  assert.ok(result.notifyMessage);

  const updated = await findByChatId('chat-pending-1');
  assert.equal(updated!.status, 'approved');
});

test('handleRejectCommand refuses a non-admin caller', async () => {
  const { createUser } = await import('../../users/service');
  const nonAdmin = await createUser('chat-caller-2');

  const { handleRejectCommand } = await import('./approve');
  const result = await handleRejectCommand(nonAdmin, 'chat-target-2');

  assert.match(result.reply, /only the admin/i);
});

test('handleRejectCommand deletes the pending user and signals notifying them', async () => {
  const { createUser, setProvider, completeSetup, findByChatId } = await import('../../users/service');
  const { encrypt } = await import('../../users/crypto');
  const admin = await createUser('chat-admin-4');
  const pending = await createUser('chat-pending-2');
  await setProvider(pending.id, 'gemini');
  await completeSetup(pending.id, encrypt('some-key'), false);

  const { handleRejectCommand } = await import('./approve');
  const result = await handleRejectCommand({ ...admin, is_admin: true }, 'chat-pending-2');

  assert.match(result.reply, /rejected/i);
  assert.equal(result.notifyChatId, 'chat-pending-2');

  const deleted = await findByChatId('chat-pending-2');
  assert.equal(deleted, null);
});
```

- [ ] **Step 2: Add `src/bot/commands/approve.test.ts` to `package.json`'s test script**

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx tsx --test src/bot/commands/approve.test.ts`
Expected: FAIL — `./approve` doesn't exist yet.

- [ ] **Step 4: Write `src/bot/commands/approve.ts`**

```typescript
/**
 * /approve and /reject — admin-only commands to gate new signups.
 */

import { approve, findByChatId, reject } from '../../users/service';
import { User } from '../../users/types';

export interface AdminActionResult {
  reply: string;
  notifyChatId?: string;
  notifyMessage?: string;
}

export async function handleApproveCommand(caller: User, targetChatId: string): Promise<AdminActionResult> {
  if (!caller.is_admin) {
    return { reply: 'Only the admin can do that.' };
  }
  if (!targetChatId.trim()) {
    return { reply: 'Usage: /approve <chat_id>' };
  }

  const target = await findByChatId(targetChatId.trim());
  if (!target) {
    return { reply: `No pending user found for chat ${targetChatId}.` };
  }

  await approve(target.id);
  return {
    reply: `Approved ${targetChatId}.`,
    notifyChatId: targetChatId,
    notifyMessage: "You're approved! Try /help to get started.",
  };
}

export async function handleRejectCommand(caller: User, targetChatId: string): Promise<AdminActionResult> {
  if (!caller.is_admin) {
    return { reply: 'Only the admin can do that.' };
  }
  if (!targetChatId.trim()) {
    return { reply: 'Usage: /reject <chat_id>' };
  }

  const target = await findByChatId(targetChatId.trim());
  if (!target) {
    return { reply: `No pending user found for chat ${targetChatId}.` };
  }

  await reject(target.id);
  return {
    reply: `Rejected ${targetChatId}.`,
    notifyChatId: targetChatId,
    notifyMessage: 'Your access request was declined.',
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx tsx --test src/bot/commands/approve.test.ts`
Expected: PASS (6/6).

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/approve.ts src/bot/commands/approve.test.ts package.json
git commit -m "feat(bot): add admin-only /approve and /reject commands"
```

---

### Task 21: `voice.ts` routes through `getProviderForUser`

Fixes the third "spec gap" call site (`transcribeVoice`, built earlier this session, also constructs `GoogleGenerativeAI(config.GOOGLE_API_KEY)` directly).

**Files:**
- Modify: `src/bot/handlers/voice.ts`
- Modify: `src/bot/handlers/voice.test.ts`

**Interfaces:**
- Produces: `transcribeVoice(userId: string, audioBuffer: Buffer, mimeType: string): Promise<string>`, `handleVoiceMessage(chatId: number, userId: string, audioBuffer: Buffer, mimeType: string): Promise<string>`

- [ ] **Step 1: Update `src/bot/handlers/voice.test.ts` (RED)**

Replace the whole file:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-voice-handler.db';

const testDbPath = path.resolve('./data/test-voice-handler.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let userId: string;

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  runMigrations();
  const { createUser, setProvider, completeSetup } = await import('../../users/service');
  const { encrypt } = await import('../../users/crypto');
  const user = await createUser('test-voice-handler-chat');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-tests'), true);
  userId = user.id;
});

function geminiTextResponse(text: string): Response {
  const body = JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

function promptTextFromBody(requestBody: string | undefined): string {
  if (!requestBody) return '';
  try {
    const parsed = JSON.parse(requestBody);
    return (
      parsed?.contents?.[0]?.parts
        ?.map((p: { text?: string }) => p.text)
        .filter(Boolean)
        .join(' ') ?? ''
    );
  } catch {
    return '';
  }
}

function isTranscriptionRequest(requestBody: string | undefined): boolean {
  if (!requestBody) return false;
  try {
    const parsed = JSON.parse(requestBody);
    return Boolean(parsed?.contents?.[0]?.parts?.[0]?.inlineData);
  } catch {
    return false;
  }
}

/**
 * Stubs a full transcribe -> classify -> categorize round trip for a
 * transcript that reads as an expense message, so handleVoiceMessage's
 * downstream classifyUserMessage/logExpense calls resolve deterministically.
 */
function stubGeminiVoiceExpenseFlow(transcript: string): () => void {
  const originalFetch = global.fetch;

  global.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = init?.body as string | undefined;

    if (isTranscriptionRequest(body)) {
      return geminiTextResponse(transcript);
    }

    const promptText = promptTextFromBody(body);
    if (promptText.includes('User message:')) {
      return geminiTextResponse(
        JSON.stringify({
          intent: 'expense',
          confidence: 0.9,
          extracted: { amount: 4.5, merchant: 'Ya Kun' },
          rawText: transcript,
        }),
      );
    }

    return geminiTextResponse(JSON.stringify({ category: 'Food', confidence: 0.9 }));
  }) as typeof fetch;

  return () => {
    global.fetch = originalFetch;
  };
}

test('handleVoiceMessage returns a friendly message when transcription fails, without touching other services', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { handleVoiceMessage } = await import('./voice');
    const reply = await handleVoiceMessage(1, userId, Buffer.from('fake ogg audio'), 'audio/ogg');

    assert.match(reply, /couldn't|trouble|sorry/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleVoiceMessage tells the user when the transcript is empty', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => geminiTextResponse('   ')) as typeof fetch;

  try {
    const { handleVoiceMessage } = await import('./voice');
    const reply = await handleVoiceMessage(2, userId, Buffer.from('fake ogg audio'), 'audio/ogg');

    assert.match(reply, /couldn't make out/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleVoiceMessage transcribes, classifies, and logs a real expense tagged with source voice', async () => {
  const transcript = 'Spent $4.50 at Ya Kun';
  const restore = stubGeminiVoiceExpenseFlow(transcript);

  try {
    const { handleVoiceMessage } = await import('./voice');
    const reply = await handleVoiceMessage(3, userId, Buffer.from('fake ogg audio'), 'audio/ogg');

    assert.match(reply, /Heard: "Spent \$4\.50 at Ya Kun"/);
    assert.match(reply, /Ya Kun/i);

    const { getTopExpenses } = await import('../../expense/service');
    const [logged] = await getTopExpenses(userId, 'today', 1);
    assert.ok(logged);
    assert.equal(logged.merchant, 'Ya Kun');
    assert.equal(logged.source, 'voice');
  } finally {
    restore();
  }
});

test('handleVoiceMessage routes the transcript to an active split instead of classification', async () => {
  const chatId = 4;
  const { startSplit, clearSplit } = await import('../../split/state');
  startSplit(chatId);

  const originalFetch = global.fetch;
  global.fetch = (async () => geminiTextResponse('split it evenly among 3')) as typeof fetch;

  try {
    const { handleVoiceMessage } = await import('./voice');
    const reply = await handleVoiceMessage(chatId, userId, Buffer.from('fake ogg audio'), 'audio/ogg');

    assert.match(reply, /waiting on a photo/i);
  } finally {
    global.fetch = originalFetch;
    clearSplit(chatId);
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/bot/handlers/voice.test.ts`
Expected: FAIL — `handleVoiceMessage`'s current signature is `(chatId, buffer, mimeType)`, doesn't accept `userId`.

- [ ] **Step 3: Update `src/bot/handlers/voice.ts`**

Replace the whole file:

```typescript
/**
 * Voice message processing for Telegram bot. Transcribes via the calling
 * user's own LLM provider (same multimodal inlineData pattern as
 * src/portfolio/statement-parser.ts), then routes the transcript through
 * the same pipeline as typed text — split-flow state first, then
 * classification.
 */

import { getProviderForUser } from '../../llm/provider';
import { findById } from '../../users/service';
import { logger } from '../../utils/logger';
import { buildAssistantReply, classifyUserMessage } from '../ai';
import { getSplitState } from '../../split/state';
import { handleSplitTextMessage } from '../commands/split';

export class VoiceTranscriptionError extends Error {}

export async function transcribeVoice(userId: string, audioBuffer: Buffer, mimeType: string): Promise<string> {
  try {
    const user = await findById(userId);
    if (!user) {
      throw new Error(`No user found with id ${userId}`);
    }
    const provider = getProviderForUser(user);

    // Voice notes are short (a few seconds), so this needs less headroom than
    // the 30s budget statement-parser.ts uses for dense multimodal PDFs.
    const response = await provider.generateText({
      systemInstruction:
        'You transcribe voice notes for a personal finance assistant. Return only the verbatim transcript as plain text, no commentary, no quotes.',
      contents: [
        { inlineData: { mimeType, data: audioBuffer.toString('base64') } },
        { text: 'Transcribe this voice note.' },
      ],
      timeoutMs: 20000,
    });

    return response.trim();
  } catch (error) {
    throw new VoiceTranscriptionError(`Gemini voice transcription failed: ${(error as Error).message}`);
  }
}

export async function handleVoiceMessage(
  chatId: number,
  userId: string,
  audioBuffer: Buffer,
  mimeType: string,
): Promise<string> {
  let transcript: string;
  try {
    transcript = await transcribeVoice(userId, audioBuffer, mimeType);
  } catch (error) {
    logger.warn('Voice transcription failed', { message: (error as Error).message });
    return "Sorry, I couldn't understand that voice note — try again or type it instead.";
  }

  if (!transcript) {
    return "I couldn't make out anything in that voice note — try again or type it instead.";
  }

  if (getSplitState(chatId)) {
    return handleSplitTextMessage(chatId, userId, transcript);
  }

  const classification = await classifyUserMessage(userId, transcript);
  logger.debug('Classified transcribed voice message', {
    intent: classification.intent,
    confidence: classification.confidence,
    transcript,
  });

  const reply = await buildAssistantReply(userId, classification, 'voice');
  return `Heard: "${transcript}"\n\n${reply}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/bot/handlers/voice.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add src/bot/handlers/voice.ts src/bot/handlers/voice.test.ts
git commit -m "feat(bot): route voice transcription through getProviderForUser"
```

---

### Task 22: Wire everything into `bot/index.ts`

The seven simple command handlers (`today`, `month`, `budget`, `export`, `undo`, `digest`, `portfolio`) have never had their own test files — they're thin wrappers already covered indirectly through the service-level tests. This task doesn't add new tests for them or for `bot/index.ts` itself (which also has no existing test file — it needs a real Grammy `Bot` instance, which is why it's always been exercised manually rather than unit-tested). Verification here is `tsc --noEmit` plus the full suite, followed by a manual smoke-test checklist.

This task still leaves two forward references uncompiled on purpose: the `/digest` handler calls `buildDigestMessage(userId)`, and the digest/recurring cron wiring inside `bot/index.ts` isn't touched yet — `digest/index.ts` and `scheduler/recurring.ts` don't accept a loop-over-users shape until Tasks 23–24. `tsc --noEmit` after this task will still show errors in those two files; that's expected and resolved by the next two tasks.

**Files:**
- Modify: `src/bot/commands/today.ts`, `src/bot/commands/month.ts`, `src/bot/commands/budget.ts`, `src/bot/commands/export.ts`, `src/bot/commands/undo.ts`, `src/bot/commands/digest.ts`, `src/bot/commands/portfolio.ts`
- Modify: `src/bot/index.ts`

**Interfaces:**
- Produces: `handleTodayCommand(userId: string)`, `handleMonthCommand(userId: string)`, `handleBudgetCommand(userId: string)`, `handleExportCommand(userId: string)`, `handleUndoCommand(userId: string)`, `handleDigestCommand(userId: string)`, `handlePortfolioCommand(userId: string)` — all `: Promise<string>`

- [ ] **Step 1: Update the seven command handler files**

`src/bot/commands/today.ts`:
```typescript
import { getSpendingSummary } from '../../expense';
import { formatSpendingSummary } from '../formatter/messages';

export async function handleTodayCommand(userId: string): Promise<string> {
  const summary = await getSpendingSummary(userId, 'today');
  return formatSpendingSummary('Today’s spend', summary);
}
```

`src/bot/commands/month.ts`:
```typescript
import { getSpendingSummary } from '../../expense';
import { formatSpendingSummary } from '../formatter/messages';

export async function handleMonthCommand(userId: string): Promise<string> {
  const summary = await getSpendingSummary(userId, 'month');
  return formatSpendingSummary('This month’s spend', summary);
}
```

`src/bot/commands/budget.ts`:
```typescript
import { getBudgetStatus } from '../../budget';

export async function handleBudgetCommand(userId: string): Promise<string> {
  const statuses = await getBudgetStatus(userId);

  if (statuses.length === 0) {
    return 'No budgets set yet. Try "Set food budget to $800/month" to create one.';
  }

  const lines = statuses.map((status) => {
    const spent = (status.spent_sgd / 100).toFixed(2);
    const limit = (status.budget_sgd / 100).toFixed(2);
    return `${status.category}: S$${spent} / S$${limit} (${status.percentage}%) — ${status.days_left_in_month} day(s) left`;
  });

  return `Budget status:\n${lines.join('\n')}`;
}
```

`src/bot/commands/export.ts`:
```typescript
import { exportCSV } from '../../expense';

export async function handleExportCommand(userId: string): Promise<string> {
  const filePath = await exportCSV(userId, new Date().getFullYear());
  return `CSV export created: ${filePath}`;
}
```

`src/bot/commands/undo.ts`:
```typescript
import { undoLastTransaction } from '../../expense';

export async function handleUndoCommand(userId: string): Promise<string> {
  const removed = await undoLastTransaction(userId);

  if (!removed) {
    return 'There is no transaction to undo yet.';
  }

  return `Removed the last transaction: ${removed.merchant} (${(removed.amount_sgd / 100).toFixed(2)} SGD).`;
}
```

`src/bot/commands/digest.ts`:
```typescript
import { buildDigestMessage } from '../../digest';

export async function handleDigestCommand(userId: string): Promise<string> {
  return buildDigestMessage(userId);
}
```

`src/bot/commands/portfolio.ts` (only the signature line changes):
```typescript
export async function handlePortfolioCommand(userId: string): Promise<string> {
  const summary = await getPortfolioSummary(userId);
  // ... rest of the function body (the formatting logic) is unchanged ...
```

- [ ] **Step 2: Rewrite `src/bot/index.ts`**

Replace the whole file:

```typescript
/**
 * Telegram bot initialization and command routing
 */

import { Bot } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { BotContext } from './context';
import { authMiddleware } from './middleware/auth';
import { errorHandlerMiddleware } from './middleware/error';
import { formatHelpMessage } from './formatter/messages';
import { handlePortfolioCommand } from './commands/portfolio';
import { handleTodayCommand } from './commands/today';
import { handleMonthCommand } from './commands/month';
import { handleBudgetCommand } from './commands/budget';
import { handleExportCommand } from './commands/export';
import { handleUndoCommand } from './commands/undo';
import { handleDigestCommand } from './commands/digest';
import { handleHelpCommand } from './commands/help';
import { handleSetupCommand, handleSetupTextMessage } from './commands/setup';
import { handleApproveCommand, handleRejectCommand } from './commands/approve';
import { handleTextMessage } from './handlers/text';
import { handleVoiceMessage } from './handlers/voice';
import { handleDocumentMessage } from './handlers/document';
import { handleSplitCommand, handleCancelCommand, handleSplitPhoto, handleSplitTextMessage } from './commands/split';
import { getSplitState } from '../split/state';

export class PlutoBot {
  private bot: Bot<BotContext>;

  constructor() {
    if (!config.TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }

    this.bot = new Bot<BotContext>(config.TELEGRAM_BOT_TOKEN);
  }

  private async replyWithText(ctx: BotContext, text: string): Promise<void> {
    await ctx.reply(text);
  }

  public async start(): Promise<void> {
    logger.info('Starting Telegram bot');

    this.bot.use(async (ctx, next) => {
      await authMiddleware(ctx, next);
    });

    this.bot.use(async (ctx, next) => {
      await errorHandlerMiddleware(ctx, next);
    });

    this.bot.command('setup', async (ctx) => {
      const reply = await handleSetupCommand(String(ctx.chat.id));
      await this.replyWithText(ctx, reply);
    });

    this.bot.command('approve', async (ctx) => {
      if (!ctx.user) return;
      const targetChatId = ctx.match?.toString().trim() ?? '';
      const result = await handleApproveCommand(ctx.user, targetChatId);
      await this.replyWithText(ctx, result.reply);
      if (result.notifyChatId && result.notifyMessage) {
        try {
          await this.bot.api.sendMessage(result.notifyChatId, result.notifyMessage);
        } catch (error) {
          logger.error('Failed to notify user of approval decision', error);
        }
      }
    });

    this.bot.command('reject', async (ctx) => {
      if (!ctx.user) return;
      const targetChatId = ctx.match?.toString().trim() ?? '';
      const result = await handleRejectCommand(ctx.user, targetChatId);
      await this.replyWithText(ctx, result.reply);
      if (result.notifyChatId && result.notifyMessage) {
        try {
          await this.bot.api.sendMessage(result.notifyChatId, result.notifyMessage);
        } catch (error) {
          logger.error('Failed to notify user of rejection decision', error);
        }
      }
    });

    this.bot.command('portfolio', async (ctx) => {
      if (!ctx.user) return;
      const response = await handlePortfolioCommand(ctx.user.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('today', async (ctx) => {
      if (!ctx.user) return;
      const response = await handleTodayCommand(ctx.user.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('month', async (ctx) => {
      if (!ctx.user) return;
      const response = await handleMonthCommand(ctx.user.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('budget', async (ctx) => {
      if (!ctx.user) return;
      const response = await handleBudgetCommand(ctx.user.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('export', async (ctx) => {
      if (!ctx.user) return;
      const response = await handleExportCommand(ctx.user.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('undo', async (ctx) => {
      if (!ctx.user) return;
      const response = await handleUndoCommand(ctx.user.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('digest', async (ctx) => {
      if (!ctx.user) return;
      const response = await handleDigestCommand(ctx.user.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('split', async (ctx) => {
      if (!ctx.user) return;
      const response = handleSplitCommand(ctx.chat.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('cancel', async (ctx) => {
      const response = handleCancelCommand(ctx.chat.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('help', async (ctx) => {
      const response = await handleHelpCommand();
      await this.replyWithText(ctx, response);
    });

    this.bot.on('message:text', async (ctx) => {
      if (!ctx.user) {
        return; // authMiddleware already replied for unregistered/pending chats
      }

      if (ctx.user.status === 'onboarding') {
        const wasEnteringApiKey = Boolean(ctx.user.llm_provider);
        const result = await handleSetupTextMessage(ctx.user, ctx.message.text);
        await this.replyWithText(ctx, result.reply);

        if (wasEnteringApiKey) {
          await ctx.deleteMessage().catch(() => {
            // best-effort — Telegram may refuse if the bot lacks delete rights
          });
        }

        if (result.notifyAdminForChatId && config.ADMIN_CHAT_ID) {
          try {
            await this.bot.api.sendMessage(
              config.ADMIN_CHAT_ID,
              `New signup pending approval: chat_id ${result.notifyAdminForChatId}. Use /approve ${result.notifyAdminForChatId} or /reject ${result.notifyAdminForChatId}.`,
            );
          } catch (error) {
            logger.error('Failed to notify admin of new signup', error);
          }
        }
        return;
      }

      if (getSplitState(ctx.chat.id)) {
        const response = await handleSplitTextMessage(ctx.chat.id, ctx.user.id, ctx.message.text);
        await this.replyWithText(ctx, response);
        return;
      }

      const response = await handleTextMessage(ctx.user.id, ctx.message.text);
      await this.replyWithText(ctx, response);
    });

    this.bot.on('message:voice', async (ctx) => {
      if (!ctx.user) return;
      const voice = ctx.message.voice;
      if (!voice) {
        return;
      }
      const file = await ctx.api.getFile(voice.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      const reply = await handleVoiceMessage(ctx.chat.id, ctx.user.id, buffer, voice.mime_type ?? 'audio/ogg');
      await this.replyWithText(ctx, reply);
    });

    this.bot.on('message:document', async (ctx) => {
      if (!ctx.user) return;
      const document = ctx.message.document;
      if (!document) {
        return;
      }
      const file = await ctx.api.getFile(document.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      const reply = await handleDocumentMessage(ctx.user.id, buffer, document.mime_type ?? '');
      await this.replyWithText(ctx, reply);
    });

    this.bot.on('message:photo', async (ctx) => {
      if (!ctx.user) return;
      const photos = ctx.message.photo;
      if (!photos || photos.length === 0) {
        return;
      }
      const largest = photos[photos.length - 1];
      const file = await ctx.api.getFile(largest.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      const reply = await handleSplitPhoto(ctx.chat.id, ctx.user.id, buffer, 'image/jpeg');
      await this.replyWithText(ctx, reply);
    });

    this.bot.command('start', async (ctx) => {
      await this.replyWithText(ctx, formatHelpMessage());
    });

    await this.bot.start({
      drop_pending_updates: true,
    });

    logger.info('Telegram bot started successfully');
  }

  public async stop(): Promise<void> {
    logger.info('Stopping Telegram bot');
    await this.bot.stop();
  }

  public getBot(): Bot<BotContext> {
    return this.bot;
  }
}

export const bot = new PlutoBot();
```

- [ ] **Step 3: Typecheck and note the expected remaining errors**

Run: `npx tsc --noEmit`
Expected: errors only in `src/scheduler/recurring.ts` and `src/digest/index.ts` (both call the not-yet-updated `fireRecurringForToday`/`buildDigestMessage`/`triggerDigestNow` with the wrong arity) and `src/webhook/` (Task 25). Everything under `src/bot/` should be clean.

- [ ] **Step 4: Commit**

```bash
git add src/bot/commands/today.ts src/bot/commands/month.ts src/bot/commands/budget.ts src/bot/commands/export.ts src/bot/commands/undo.ts src/bot/commands/digest.ts src/bot/commands/portfolio.ts src/bot/index.ts
git commit -m "feat(bot): wire /setup, /approve, /reject, and userId-scoped handlers into the bot"
```

---

### Task 23: `scheduler/recurring.ts` loops approved users

`deliverBudgetAlerts` no longer reads a single global `TELEGRAM_AUTHORIZED_CHAT_ID` — it takes the target chat and user explicitly, since the cron now fires once per approved user. Per-user errors are caught and logged individually so one user's failure never blocks another's run (an explicit PLUTO-09 acceptance criterion) — this also means `triggerRecurringNow` no longer re-throws on failure the way it used to; that's an intentional behavior change, not an oversight.

**Files:**
- Modify: `src/scheduler/recurring.ts`
- Modify: `src/scheduler/recurring.test.ts`

**Interfaces:**
- Consumes: `listApproved` (Task 4), `fireRecurringForToday(userId, ...)` (Task 7), `checkAlerts(userId, ...)` (Task 10)
- Produces: `deliverBudgetAlerts(api: Api | null, telegramChatId: string, userId: string, transactions: Transaction[]): Promise<void>`

- [ ] **Step 1: Update `src/scheduler/recurring.test.ts` (RED)**

Replace the whole file:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.DATABASE_URL = './data/test-scheduler-alerts.db';

const testDbPath = path.resolve('./data/test-scheduler-alerts.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let userId: string;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
  const { createUser } = await import('../users/service');
  const user = await createUser('test-chat-id');
  userId = user.id;
});

function fakeTransaction(category: string, amountSgdCents: number) {
  const now = new Date();
  return {
    id: randomUUID(),
    amount: amountSgdCents,
    currency: 'SGD' as const,
    amount_sgd: amountSgdCents,
    merchant: 'Test merchant',
    category: category as any,
    source: 'recurring',
    card_name: 'Recurring',
    created_at: now,
    updated_at: now,
  };
}

// checkAlerts (src/budget/alerts.ts) computes month-to-date spend by querying
// the `transactions` table directly (via getSpendingByCategory) — it does not
// read the amount off the Transaction object passed in. Tests that expect an
// alert to fire must persist the transaction first, the same way
// src/budget/alerts.test.ts's own insertTransaction() helper does.
async function insertTransaction(category: string, amountSgdCents: number) {
  const { db, transactions } = await import('../db');
  const txn = fakeTransaction(category, amountSgdCents);
  await db.insert(transactions).values({
    id: txn.id,
    user_id: userId,
    amount: txn.amount,
    currency: txn.currency,
    amount_sgd: txn.amount_sgd,
    merchant: txn.merchant,
    category: txn.category,
    source: txn.source,
    card_name: txn.card_name,
    created_at: txn.created_at.getTime(),
    updated_at: txn.updated_at.getTime(),
  });
  return txn;
}

test('deliverBudgetAlerts does nothing when there are no transactions', async () => {
  const { deliverBudgetAlerts } = await import('./recurring');
  const sent: Array<{ chatId: string; text: string }> = [];
  const fakeApi = { sendMessage: async (chatId: string, text: string) => { sent.push({ chatId, text }); } } as any;

  await deliverBudgetAlerts(fakeApi, 'test-chat-id', userId, []);
  assert.equal(sent.length, 0);
});

test('deliverBudgetAlerts does nothing when no api is available', async () => {
  const { deliverBudgetAlerts } = await import('./recurring');
  await deliverBudgetAlerts(null, 'test-chat-id', userId, [fakeTransaction('Food', 8500)]);
});

test('deliverBudgetAlerts sends a message when a transaction crosses a threshold', async () => {
  const { setBudget } = await import('../budget/service');
  const { deliverBudgetAlerts } = await import('./recurring');

  await setBudget(userId, 'Entertainment', 100, 'SGD');
  const transaction = await insertTransaction('Entertainment', 8500);

  const sent: Array<{ chatId: string; text: string }> = [];
  const fakeApi = { sendMessage: async (chatId: string, text: string) => { sent.push({ chatId, text }); } } as any;

  await deliverBudgetAlerts(fakeApi, 'test-chat-id', userId, [transaction]);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'test-chat-id');
  assert.match(sent[0].text, /Entertainment/);
});

test('deliverBudgetAlerts keeps processing later transactions after sendMessage throws for an earlier one', async () => {
  const { setBudget } = await import('../budget/service');
  const { deliverBudgetAlerts } = await import('./recurring');

  await setBudget(userId, 'Bills', 100, 'SGD');
  await setBudget(userId, 'Health', 100, 'SGD');

  const failing = await insertTransaction('Bills', 8500); // crosses 80%, send will throw
  const healthy = await insertTransaction('Health', 8500); // also crosses 80%, send should succeed

  const sent: Array<{ chatId: string; text: string }> = [];
  const fakeApi = {
    sendMessage: async (chatId: string, text: string) => {
      if (text.includes('Bills')) {
        throw new Error('simulated Telegram send failure');
      }
      sent.push({ chatId, text });
    },
  } as any;

  await assert.doesNotReject(() => deliverBudgetAlerts(fakeApi, 'test-chat-id', userId, [failing, healthy]));

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Health/);
});

test('triggerRecurringNow fires due recurring entries once per approved user', async () => {
  const { createUser, approve, setProvider } = await import('../users/service');
  const { createRecurring, getRecurringFiredToday } = await import('../expense/service');
  const { triggerRecurringNow } = await import('./recurring');

  const userA = await createUser('test-scheduler-user-a');
  await setProvider(userA.id, 'gemini');
  await approve(userA.id);
  await createRecurring(userA.id, {
    amount: 10,
    currency: 'SGD',
    merchant: 'A Subscription',
    category: 'Entertainment', // explicit category — no Gemini call needed to fire this
    day_of_month: new Date().getDate(),
    is_active: true,
  });

  const sent: Array<{ chatId: string; text: string }> = [];
  const fakeBot = {
    api: { sendMessage: async (chatId: string, text: string) => { sent.push({ chatId, text }); } },
  } as any;

  await assert.doesNotReject(() => triggerRecurringNow(fakeBot));

  const fired = await getRecurringFiredToday(userA.id);
  assert.ok(fired.some((t) => t.merchant === 'A Subscription'));
});

test('triggerRecurringNow does not let one user\'s failure block another user\'s recurring entries from firing', async () => {
  const { createUser, approve, setProvider } = await import('../users/service');
  const { createRecurring, getRecurringFiredToday } = await import('../expense/service');
  const { triggerRecurringNow } = await import('./recurring');

  const failingUser = await createUser('test-scheduler-failing-user');
  await setProvider(failingUser.id, 'gemini');
  await approve(failingUser.id);
  await createRecurring(failingUser.id, {
    amount: 5,
    currency: 'SGD',
    merchant: 'Failing Sub',
    category: 'Bills',
    day_of_month: new Date().getDate(),
    is_active: true,
  });

  const healthyUser = await createUser('test-scheduler-healthy-user');
  await setProvider(healthyUser.id, 'gemini');
  await approve(healthyUser.id);
  await createRecurring(healthyUser.id, {
    amount: 5,
    currency: 'SGD',
    merchant: 'Healthy Sub',
    category: 'Bills',
    day_of_month: new Date().getDate(),
    is_active: true,
  });

  const fakeBot = {
    api: {
      sendMessage: async (chatId: string) => {
        if (chatId === 'test-scheduler-failing-user') {
          throw new Error('simulated send failure for the failing user');
        }
      },
    },
  } as any;

  await assert.doesNotReject(() => triggerRecurringNow(fakeBot));

  const healthyFired = await getRecurringFiredToday(healthyUser.id);
  assert.ok(healthyFired.some((t) => t.merchant === 'Healthy Sub'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/scheduler/recurring.test.ts`
Expected: FAIL — `deliverBudgetAlerts` doesn't accept `(api, telegramChatId, userId, transactions)` yet, and `triggerRecurringNow`/the underlying `fireRecurringForToday` calls don't loop over users yet.

- [ ] **Step 3: Update `src/scheduler/recurring.ts`**

Replace the whole file:

```typescript
/**
 * Recurring transactions scheduler
 * Automatically logs recurring transactions on their scheduled day, once
 * per approved user, then checks each one against that user's budget alert
 * thresholds.
 */

import * as cron from 'node-cron';
import { Api, Bot } from 'grammy';
import { fireRecurringForToday } from '../expense/service';
import { checkAlerts } from '../budget/alerts';
import { listApproved } from '../users/service';
import { Transaction } from '../types';
import { logger } from '../utils/logger';

let schedulerTask: cron.ScheduledTask | null = null;

/**
 * Check each newly created transaction against its category budget and push
 * a Telegram message for any newly crossed threshold, for one user.
 */
export async function deliverBudgetAlerts(
  api: Api | null,
  telegramChatId: string,
  userId: string,
  transactions: Transaction[],
): Promise<void> {
  if (transactions.length === 0) {
    return;
  }

  if (!api) {
    logger.warn('Skipping budget alert delivery: no bot instance available');
    return;
  }

  for (const transaction of transactions) {
    const alert = await checkAlerts(userId, transaction);
    if (alert) {
      try {
        await api.sendMessage(telegramChatId, alert.message);
      } catch (error) {
        logger.error('Failed to deliver budget alert', error);
      }
    }
  }
}

/**
 * Fires due recurring entries for every approved user. One user's failure
 * (a thrown error anywhere in their own processing) is caught and logged
 * without blocking the rest of the run.
 */
async function fireForAllApprovedUsers(bot: Bot | null): Promise<void> {
  const users = await listApproved();

  for (const user of users) {
    try {
      const created = await fireRecurringForToday(user.id);
      if (created.length > 0) {
        logger.info(`Created ${created.length} recurring transaction(s) for user ${user.id}`, {
          transactions: created.map((t) => ({ merchant: t.merchant, amount: t.amount, category: t.category })),
        });
        await deliverBudgetAlerts(bot?.api ?? null, user.telegram_chat_id, user.id, created);
      } else {
        logger.debug(`No recurring transactions due today for user ${user.id}`);
      }
    } catch (error) {
      logger.error(`Failed to process recurring transactions for user ${user.id}`, error);
    }
  }
}

/**
 * Start the recurring transactions scheduler.
 * Runs daily at midnight (00:00) to check and log any recurring transactions
 * due today, for every approved user. `bot` is used to push budget alerts —
 * pass null if the Telegram bot isn't running.
 */
export function startRecurringScheduler(bot: Bot | null): void {
  if (schedulerTask) {
    logger.warn('Recurring scheduler already running, skipping start');
    return;
  }

  schedulerTask = cron.schedule('0 0 * * *', async () => {
    logger.info('Running recurring transactions scheduler');
    await fireForAllApprovedUsers(bot);
  });

  logger.info('Recurring transactions scheduler started (runs daily at 00:00)');
}

/**
 * Stop the recurring transactions scheduler
 */
export function stopRecurringScheduler(): void {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
    logger.info('Recurring transactions scheduler stopped');
  }
}

/**
 * Manually trigger recurring transactions for every approved user (useful
 * for testing or startup recovery).
 */
export async function triggerRecurringNow(bot: Bot | null): Promise<void> {
  logger.info('Manually triggering recurring transactions');
  await fireForAllApprovedUsers(bot);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test src/scheduler/recurring.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/recurring.ts src/scheduler/recurring.test.ts
git commit -m "feat(scheduler): loop the recurring-transaction cron over every approved user"
```

---

### Task 24: `digest/index.ts` loops approved users

**Files:**
- Modify: `src/digest/index.ts`
- Modify: `src/digest/digest.test.ts` (the remaining `triggerDigestNow`/`buildDigestMessage` tests)

**Interfaces:**
- Consumes: `listApproved` (Task 4), `collectDigestData(userId, ...)` (Task 15), `generateSummaryLine(userId, ...)` (Task 15)
- Produces: `buildDigestMessage(userId: string): Promise<string>`

- [ ] **Step 1: Update the remaining tests in `src/digest/digest.test.ts` (RED)**

Remove the now-dead `process.env.TELEGRAM_AUTHORIZED_CHAT_ID = 'test-chat-id';` line near the top of the file (sends now go to each approved user's real `telegram_chat_id`, resolved via `listApproved()`, not a global env var).

Replace the last three tests:

```typescript
test('triggerDigestNow does not throw when no bot is available', async () => {
  const { triggerDigestNow } = await import('./index');
  await assert.doesNotReject(() => triggerDigestNow(null));
});

test('triggerDigestNow sends the built digest message to every approved user', async () => {
  const { triggerDigestNow } = await import('./index');
  const sent: Array<{ chatId: string; text: string }> = [];
  const fakeBot = {
    api: {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      },
    },
  } as any;

  await triggerDigestNow(fakeBot);

  assert.equal(sent.length, 1); // only the one approved user created in before()
  assert.equal(sent[0].chatId, 'test-digest-chat');
  assert.match(sent[0].text, /Daily Digest/);
});

test('buildDigestMessage returns a string containing the digest header', async () => {
  const { buildDigestMessage } = await import('./index');
  const message = await buildDigestMessage(userId);
  assert.match(message, /^Daily Digest - /);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/digest/digest.test.ts`
Expected: FAIL on the three updated tests (`triggerDigestNow`/`buildDigestMessage` don't loop over users or accept a `userId` yet); the tests from Task 15 still pass.

- [ ] **Step 3: Update `src/digest/index.ts`**

Replace the whole file:

```typescript
/**
 * Daily digest scheduler, manual trigger, and message builder.
 */

import * as cron from 'node-cron';
import { Bot } from 'grammy';
import { logger } from '../utils/logger';
import { listApproved } from '../users/service';
import { collectDigestData } from './aggregator';
import { formatDigestMessage } from './formatter';
import { generateSummaryLine } from './summary';

let schedulerTask: cron.ScheduledTask | null = null;

export async function buildDigestMessage(userId: string): Promise<string> {
  const data = await collectDigestData(userId);
  const summaryLine = await generateSummaryLine(userId, data);
  return formatDigestMessage(data, summaryLine);
}

export async function triggerDigestNow(bot: Bot | null): Promise<void> {
  if (!bot) {
    logger.warn('Skipping digest delivery: no bot instance available');
    return;
  }

  const users = await listApproved();

  for (const user of users) {
    try {
      logger.info(`Building daily digest for user ${user.id}`);
      const message = await buildDigestMessage(user.id);
      await bot.api.sendMessage(user.telegram_chat_id, message);
      logger.info(`Daily digest sent to user ${user.id}`);
    } catch (error) {
      logger.error(`Failed to send daily digest to user ${user.id}`, error);
    }
  }
}

export function startDigestScheduler(bot: Bot | null): void {
  if (schedulerTask) {
    logger.warn('Digest scheduler already running, skipping start');
    return;
  }

  schedulerTask = cron.schedule(
    '0 22 * * *',
    async () => {
      logger.info('Running daily digest scheduler');
      try {
        await triggerDigestNow(bot);
      } catch (error) {
        logger.error('Failed to run daily digest', error);
      }
    },
    { timezone: 'Asia/Singapore' },
  );

  logger.info('Daily digest scheduler started (runs daily at 22:00 Asia/Singapore)');
}

export function stopDigestScheduler(): void {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
    logger.info('Daily digest scheduler stopped');
  }
}
```

- [ ] **Step 4: Run the full digest suite to verify it passes**

Run: `npx tsx --test src/digest/digest.test.ts`
Expected: PASS (12/12).

- [ ] **Step 5: Commit**

```bash
git add src/digest/index.ts src/digest/digest.test.ts
git commit -m "feat(digest): loop the nightly digest cron over every approved user"
```

---

### Task 25: Webhook resolves `x-api-key` → user

**Design note found necessary during planning:** the original test for "returns 500 without crashing when logExpense fails" simulated a DB outage by mutating `config.DATABASE_URL` between requests. That worked against the *old* `expense/service.ts`, which opened a fresh raw `better-sqlite3` connection on every call. It no longer works: Task 6 moved `logExpense` onto the shared Drizzle `db` singleton (`src/db/client.ts`), which opens its connection once and never re-reads `config.DATABASE_URL` afterward. This task's test instead closes the underlying sqlite connection directly (`getSQLiteDb().close()`), and `createWebhookApp` gains a Hono `app.onError` handler so *any* unhandled error in the app — not just ones inside the route handler's own try/catch — degrades to the same `{status: 'error', ...}` JSON shape instead of Hono's default plain-text 500 page. This is a real robustness improvement, not just a test workaround: without it, a DB outage during the auth lookup itself (before the route handler's own try/catch even runs) would have leaked a non-JSON error page to the iOS Shortcut caller.

**Files:**
- Modify: `src/webhook/auth.ts`
- Modify: `src/webhook/routes/apple-pay.ts`
- Modify: `src/webhook/index.ts`
- Modify: `src/webhook/webhook.test.ts`

**Interfaces:**
- Consumes: `findByWebhookKey` (Task 4)
- Produces: `apiKeyAuthMiddleware` now resolves and requires an *approved* user; `createApplePayHandler` reads that user off the Hono context instead of a global chat id

- [ ] **Step 1: Update `src/webhook/webhook.test.ts` (RED)**

Replace the whole file:

```typescript
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stubGeminiCategorization } from '../testing/geminiStub';

process.env.DATABASE_URL = './data/test-webhook.db';

const testDbPath = path.resolve('./data/test-webhook.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let restoreGeminiStub: () => void;
let webhookApiKey: string;

before(async () => {
  restoreGeminiStub = stubGeminiCategorization();
  const { runMigrations } = await import('../db/migrate');
  runMigrations();

  const { createUser, setProvider, completeSetup, approve } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const user = await createUser('test-chat-id');
  await setProvider(user.id, 'gemini');
  const completed = await completeSetup(user.id, encrypt('fake-key-for-tests'), false);
  await approve(user.id);
  webhookApiKey = completed.webhook_api_key!;
});

after(() => {
  restoreGeminiStub();
});

function fakeBot() {
  const sent: Array<{ chatId: string; text: string }> = [];
  const bot = {
    api: {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      },
    },
  } as any;
  return { bot, sent };
}

test('GET /api/health returns ok without auth', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('POST /api/apple-pay rejects requests with no x-api-key header', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: '4.50', merchant: 'Ya Kun', card: 'DBS' }),
  });

  assert.equal(res.status, 401);
});

test('POST /api/apple-pay rejects requests with the wrong x-api-key', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'wrong-secret' },
    body: JSON.stringify({ amount: '4.50', merchant: 'Ya Kun', card: 'DBS' }),
  });

  assert.equal(res.status, 401);
});

test('POST /api/apple-pay rejects a key belonging to a not-yet-approved user', async () => {
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const pendingUser = await createUser('test-chat-pending');
  await setProvider(pendingUser.id, 'gemini');
  const completed = await completeSetup(pendingUser.id, encrypt('fake-key'), false); // stays pending_approval

  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': completed.webhook_api_key! },
    body: JSON.stringify({ amount: '4.50', merchant: 'Ya Kun', card: 'DBS' }),
  });

  assert.equal(res.status, 401);
});

test('POST /api/apple-pay rejects a payload missing required fields', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': webhookApiKey },
    body: JSON.stringify({ amount: '4.50', merchant: 'Ya Kun' }),
  });

  assert.equal(res.status, 400);
});

test('POST /api/apple-pay rejects a non-numeric amount', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': webhookApiKey },
    body: JSON.stringify({ amount: 'not-a-number', merchant: 'Ya Kun', card: 'DBS' }),
  });

  assert.equal(res.status, 400);
});

test('POST /api/apple-pay logs the transaction, maps card to currency, and sends a Telegram confirmation', async () => {
  const { createWebhookApp } = await import('./index');
  const { bot, sent } = fakeBot();
  const app = createWebhookApp(bot);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': webhookApiKey },
    body: JSON.stringify({ amount: '4.50', merchant: 'Ya Kun Kaya Toast', card: 'DBS' }),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.status, 'logged');
  assert.equal(body.transaction.amount, 4.5);
  assert.equal(body.transaction.currency, 'SGD');
  assert.equal(body.transaction.merchant, 'Ya Kun Kaya Toast');
  assert.ok(body.transaction.category);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'test-chat-id');
  assert.match(sent[0].text, /Spent S\$4\.50 at Ya Kun Kaya Toast/);
});

test('POST /api/apple-pay treats a currency prefix on the amount as an explicit override', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': webhookApiKey },
    body: JSON.stringify({ amount: 'RM 45.00', merchant: 'Kopitiam', card: 'DBS' }),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.transaction.amount, 45);
  assert.equal(body.transaction.currency, 'MYR');
});

test('POST /api/apple-pay returns 500 without crashing when the database is unreachable', async () => {
  const { createWebhookApp } = await import('./index');
  const { getSQLiteDb } = await import('../db');
  const app = createWebhookApp(null);

  getSQLiteDb().close(); // forces the next query (the auth lookup) to throw — must be this file's last test

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': webhookApiKey },
    body: JSON.stringify({ amount: '4.50', merchant: 'Ya Kun', card: 'DBS' }),
  });

  assert.equal(res.status, 500);
  const body = (await res.json()) as any;
  assert.equal(body.status, 'error');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test src/webhook/webhook.test.ts`
Expected: FAIL — the current middleware compares against `config.WEBHOOK_API_KEY`, so a per-user generated key doesn't authenticate.

- [ ] **Step 3: Update `src/webhook/auth.ts`**

```typescript
/**
 * API key -> user resolution for the iOS Shortcut webhook. A key only
 * authenticates an approved user — one generated during onboarding but not
 * yet approved (or belonging to a rejected/removed user) is refused.
 */

import { Context, Next } from 'hono';
import { findByWebhookKey } from '../users/service';

export async function apiKeyAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
  const providedKey = c.req.header('x-api-key');

  if (!providedKey) {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }

  const user = await findByWebhookKey(providedKey);
  if (!user || user.status !== 'approved') {
    return c.json({ status: 'error', message: 'Unauthorized' }, 401);
  }

  c.set('user', user);
  await next();
}
```

- [ ] **Step 4: Update `src/webhook/routes/apple-pay.ts`**

Replace the `sendConfirmation` and `createApplePayHandler` functions (the top of the file — `parseAmount` and the imports it needs — is unchanged, but add a `User` import):

```typescript
import { User } from '../../users/types';

// ... parseAmount unchanged ...

async function sendConfirmation(bot: Bot | null, telegramChatId: string, transaction: Transaction): Promise<void> {
  if (!bot) {
    return;
  }

  const amountLabel = formatCurrency(transaction.amount, transaction.currency);
  const message = `Spent ${amountLabel} at ${transaction.merchant} — ${transaction.category}`;

  try {
    await bot.api.sendMessage(telegramChatId, message);
  } catch (error) {
    logger.error('Failed to send Apple Pay confirmation via Telegram', error);
  }
}

export function createApplePayHandler(bot: Bot | null) {
  return async (c: Context): Promise<Response> => {
    const user = c.get('user') as User; // set by apiKeyAuthMiddleware

    let payload: Partial<ApplePayPayload>;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ status: 'error', message: 'Invalid JSON payload' }, 400);
    }

    const parsedAmount = parseAmount(payload.amount);
    const merchant = typeof payload.merchant === 'string' ? payload.merchant.trim() : '';
    const card = typeof payload.card === 'string' ? payload.card.trim() : '';

    if (!parsedAmount || !merchant || !card) {
      return c.json({ status: 'error', message: 'amount, merchant, and card are required' }, 400);
    }

    try {
      const transaction = await logExpense(user.id, {
        amount: parsedAmount.amount,
        currency: parsedAmount.currency,
        merchant,
        cardName: card,
        source: 'apple_pay',
      });

      await sendConfirmation(bot, user.telegram_chat_id, transaction);

      return c.json(
        {
          status: 'logged',
          transaction: {
            amount: transaction.amount / 100,
            currency: transaction.currency,
            merchant: transaction.merchant,
            category: transaction.category,
          },
        },
        200,
      );
    } catch (error) {
      logger.error('Failed to log Apple Pay transaction from webhook', error);
      return c.json({ status: 'error', message: 'Failed to log transaction' }, 500);
    }
  };
}
```

- [ ] **Step 5: Update `src/webhook/index.ts`**

Replace the whole file:

```typescript
/**
 * iOS Shortcut webhook HTTP server (Hono, served via @hono/node-server).
 * Runs on config.PORT, independent of the Telegram bot's long-polling loop.
 * Always starts — auth is per-request (x-api-key -> user), not a single
 * global secret gating startup.
 */

import { serve, ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { Bot } from 'grammy';
import { config } from '../config';
import { logger } from '../utils/logger';
import { apiKeyAuthMiddleware } from './auth';
import { createApplePayHandler } from './routes/apple-pay';

export function createWebhookApp(bot: Bot | null): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    logger.error('Unhandled webhook error', err);
    return c.json({ status: 'error', message: 'Internal server error' }, 500);
  });

  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.post('/api/apple-pay', apiKeyAuthMiddleware, createApplePayHandler(bot));

  return app;
}

export function startWebhookServer(bot: Bot | null): ServerType {
  const app = createWebhookApp(bot);
  const port = Number(config.PORT);

  const server = serve({ fetch: app.fetch, port }, (info) => {
    logger.info(`Webhook server listening on port ${info.port}`);
  });

  return server;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx tsx --test src/webhook/webhook.test.ts`
Expected: PASS (9/9).

- [ ] **Step 7: Commit**

```bash
git add src/webhook/auth.ts src/webhook/routes/apple-pay.ts src/webhook/index.ts src/webhook/webhook.test.ts
git commit -m "feat(webhook): resolve x-api-key to an approved user instead of one global secret"
```

---

### Task 26: Remove `GOOGLE_API_KEY`, `WEBHOOK_API_KEY`, `TELEGRAM_AUTHORIZED_CHAT_ID` from config

By this point every call site that used these three has been migrated (Tasks 13–16, 18, 21, 23–25). This task removes them from the env schema and verifies nothing still references them.

**Files:**
- Modify: `src/config/env.ts`
- Modify: `src/config/env.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `Config` no longer has `GOOGLE_API_KEY`, `WEBHOOK_API_KEY`, or `TELEGRAM_AUTHORIZED_CHAT_ID`

- [ ] **Step 1: Grep for remaining references before touching anything**

Run: `grep -rn "GOOGLE_API_KEY\|WEBHOOK_API_KEY\|TELEGRAM_AUTHORIZED_CHAT_ID" src/`

Expected: only `src/config/env.ts` (the schema field definitions) and `src/config/env.test.ts` (the now-unused `GOOGLE_API_KEY: 'unused-in-this-file'` line in its `BASE_ENV` fixture, harmless since zod silently ignores unknown keys on a non-`.strict()` schema, but worth cleaning up in Step 3 anyway). If this turns up anything else, stop and fix that call site first — it means an earlier task's migration was incomplete.

- [ ] **Step 2: Update `src/config/env.ts`**

Remove `TELEGRAM_AUTHORIZED_CHAT_ID`, `GOOGLE_API_KEY`, and `WEBHOOK_API_KEY` from the schema:

```typescript
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DATABASE_URL: z.string().default('./data/pluto.db'),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    ADMIN_CHAT_ID: z.string().optional(),
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, 'ENCRYPTION_KEY must be a 64-character hex string (32 bytes) for AES-256-GCM'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    PORT: z.string().default('3000'),
  })
  .superRefine((val, ctx) => {
    if (val.TELEGRAM_BOT_TOKEN && !val.ADMIN_CHAT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADMIN_CHAT_ID'],
        message:
          'ADMIN_CHAT_ID is required when TELEGRAM_BOT_TOKEN is set — without a designated admin, no user (including the first) can be approved.',
      });
    }
  });
```

- [ ] **Step 3: Clean up `src/config/env.test.ts`**

In `BASE_ENV`, remove the now-meaningless `GOOGLE_API_KEY: 'unused-in-this-file',` line.

- [ ] **Step 4: Update `.env.example`**

Remove the `TELEGRAM_AUTHORIZED_CHAT_ID`, `GOOGLE_API_KEY`, and `WEBHOOK_API_KEY` blocks entirely and add:

```
# The Telegram chat_id that gets admin rights: auto-approved on /setup, and
# the only chat that can run /approve and /reject. Required whenever
# TELEGRAM_BOT_TOKEN is set.
ADMIN_CHAT_ID=your_telegram_chat_id_here
```

(The `ENCRYPTION_KEY` block added back in Task 2 stays as-is.)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: every test file passes (some may show `GOOGLE_API_KEY`/`WEBHOOK_API_KEY` no longer needed in their own `process.env` setup lines — leave those alone unless they fail; an extra unused env var assignment in a test file is harmless and out of scope to hunt down here).

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src --ext .ts`
Expected: clean (lint may still show the repo's pre-existing debt noted in CLAUDE.md — don't chase that here).

- [ ] **Step 7: Commit**

```bash
git add src/config/env.ts src/config/env.test.ts .env.example
git commit -m "chore(config): remove GOOGLE_API_KEY, WEBHOOK_API_KEY, TELEGRAM_AUTHORIZED_CHAT_ID"
```

---

### Task 27: Update docs for the multi-user reality

Not TDD (docs, not code) — verify by re-reading each changed section against the actual code once done, the same discipline CLAUDE.md itself asks for ("this file has been wrong about intent wiring... before").

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `docs/setup/ios-shortcut-setup.md`
- Modify: `docs/tasks/09-multi-users.md`

- [ ] **Step 1: `CLAUDE.md` — rewrite the now-stale sections**

Specific known-stale claims to fix (there may be other smaller ones a careful re-read turns up — fix those too):

- The "Two independent SQLite access paths" section (`### Two independent SQLite access paths — read before touching persistence`) describes `expense/service.ts` as using its own raw `better-sqlite3` connection. That's no longer true after Task 6/7 — replace this whole section with a short note that `expense/service.ts` is now Drizzle-backed like every other module, and there is only one persistence path.
- The project overview paragraph's claim `GOOGLE_API_KEY is a required env var` is no longer accurate — each user brings their own key via `/setup`, encrypted at rest; `ENCRYPTION_KEY` and `ADMIN_CHAT_ID` are the new required/conditionally-required env vars.
- Add a new subsection (e.g. `### Multi-user & onboarding`) covering: the `users` table and its `status` state machine (`onboarding` → `pending_approval`/`approved`), `/setup`'s provider-then-key flow (Gemini-only this slice), `/approve`/`/reject`, `authMiddleware`'s gating, and the `LLMProvider` abstraction (`src/llm/provider.ts` + `src/llm/gemini.ts`, one implementation today).
- Update the "Request flow (Telegram)" section's description of `authMiddleware` (currently "single-chat allowlist") to describe the users-row resolution instead.
- Note that `docs/tasks/09-multi-users.md`'s OpenAI/Anthropic providers are not yet implemented — link to `docs/superpowers/specs/2026-09-09-multi-user-core-slice-design.md` for why.

- [ ] **Step 2: `README.md` — update setup instructions and feature descriptions**

- The env var table needs `ADMIN_CHAT_ID` and `ENCRYPTION_KEY` added, and `TELEGRAM_AUTHORIZED_CHAT_ID`/`GOOGLE_API_KEY`/`WEBHOOK_API_KEY` removed.
- The "Setup" walkthrough needs a new step describing `/setup` (pick `gemini`, paste an API key, wait for admin approval unless you're `ADMIN_CHAT_ID`).
- Any description of the app as single-owner/personal-only needs updating to mention multiple Telegram chats can now register.
- The Troubleshooting section's `GOOGLE_API_KEY`-related entries need replacing with `ENCRYPTION_KEY`/`ADMIN_CHAT_ID` equivalents.

- [ ] **Step 3: `docs/setup/ios-shortcut-setup.md` — per-user webhook key**

This doc currently assumes a single shared `WEBHOOK_API_KEY` from `.env`. Update it to explain the key now comes from that user's own completed `/setup` (`webhook_api_key`, generated automatically and shown to them, or retrievable however the doc's existing UX describes obtaining secrets) rather than an operator-set environment variable.

- [ ] **Step 4: `docs/tasks/09-multi-users.md` — mark the slice status**

Add a short status note near the top (don't rewrite the doc): this task shipped as two slices — the auth model, persistence migration, and a Gemini-only `LLMProvider` are done (link `docs/superpowers/plans/2026-09-09-multi-user-core-slice.md`); OpenAI/Anthropic providers are a follow-up slice, not yet built.

- [ ] **Step 5: Final full verification**

Run: `npm test && npx tsc --noEmit && npx eslint src --ext .ts`
Expected: full suite green, clean typecheck, lint shows only the repo's pre-existing debt.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md docs/setup/ios-shortcut-setup.md docs/tasks/09-multi-users.md
git commit -m "docs: update CLAUDE.md, README, and setup docs for multi-user reality"
```

