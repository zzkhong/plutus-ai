# Telegram Bot Core (PLUTO-02) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking — this plan is retrospective, documenting work already completed, so every step is checked off.

**Goal:** Ship the Telegram conversational UI: slash command routing, a Gemini-backed free-text intent classifier with no rule-based fallback, natural-language reply generation, single-chat auth, and graceful error handling.

**Architecture:** A `PlutoBot` class (`src/bot/index.ts`) owns a grammy `Bot` instance, wires an auth middleware and a catch-all error middleware ahead of command/message handlers, and exposes `getBot()` so later modules (schedulers, the future webhook) can send messages through the same instance without depending on `PlutoBot` itself. Free text flows through `src/bot/ai.ts`'s `classifyUserMessage` (Gemini) → `buildAssistantReply` (intent → domain call + natural-language text), with domain modules invoked via dynamic `import()` per intent to avoid import-order coupling.

**Tech Stack:** TypeScript, grammy (Telegram bot framework, long polling), `@google/generative-ai` (Gemini), node's built-in test runner.

**Spec:** [docs/superpowers/specs/2026-08-16-telegram-bot-design.md](../specs/2026-08-16-telegram-bot-design.md)

## Global Constraints

- No regex/keyword intent classification, ever — not as a primary path, and not as a silent fallback when Gemini is unavailable or fails. `GOOGLE_API_KEY` is a required env var (enforced in PLUTO-01's `env.ts`); a runtime Gemini failure must surface `formatUserFriendlyError()`, not a guessed intent.
- Pin an explicit Gemini model id (never an alias) so behavior can't drift silently when Google rotates an alias; check `GET /v1beta/models` against the configured key if classification starts failing.
- The bot must not crash on a bad Telegram update or a failing domain call — `errorHandlerMiddleware` is the last line of defense and must always be registered before any command/message handler.
- Single-chat auth: if `TELEGRAM_AUTHORIZED_CHAT_ID` is unset, auth is intentionally a no-op (open to any chat) rather than a hard failure — this is a personal single-user tool.
- Domain modules (expense engine, budget system) are consumed via dynamic `import()` inside `buildAssistantReply`'s switch cases, not static imports at the top of `ai.ts` — this was the established pattern from the first wired case (`correction`) and every later case follows it.

---

## File Structure

```
src/bot/index.ts                    (implemented) — PlutoBot class
src/bot/types.ts                    (implemented) — BotIntent, CommandName, BotCommandResponse
src/bot/ai.ts                       (implemented) — classifyUserMessage, buildAssistantReply
src/bot/ai.test.ts                  (implemented)
src/bot/middleware/auth.ts          (implemented) — authMiddleware
src/bot/middleware/error.ts         (implemented) — errorHandlerMiddleware
src/bot/commands/portfolio.ts       (implemented) — placeholder (PLUTO-04 not built yet)
src/bot/commands/today.ts           (implemented) — wired once PLUTO-03 landed
src/bot/commands/month.ts           (implemented) — wired once PLUTO-03 landed
src/bot/commands/budget.ts          (implemented) — placeholder until PLUTO-05
src/bot/commands/export.ts          (implemented) — wired once PLUTO-03 landed
src/bot/commands/undo.ts            (implemented) — wired once PLUTO-03 landed
src/bot/commands/help.ts            (implemented)
src/bot/commands/index.ts           (implemented) — barrel export
src/bot/handlers/text.ts            (implemented) — classify + reply
src/bot/handlers/voice.ts           (implemented) — stub, see spec's Out of scope
src/bot/formatter/messages.ts       (implemented) — shared reply formatting
src/config/env.ts                   (modified) — TELEGRAM_AUTHORIZED_CHAT_ID added
src/index.ts                        (modified) — constructs and starts PlutoBot
package.json                        (modified) — registers src/bot/ai.test.ts in the test script
```

---

### Task 1: Bot-specific types

**Files:** `src/bot/types.ts`

- [x] **Step 1: Define `BotIntent`, `CommandName`, `BotCommandResponse`**

```typescript
export type BotIntent = 'expense' | 'query' | 'budget' | 'correction' | 'recurring' | 'help' | 'unknown';
export type CommandName = 'portfolio' | 'today' | 'month' | 'budget' | 'export' | 'undo' | 'help';
export interface BotCommandResponse { command: CommandName; text: string; }
```

---

### Task 2: Shared message formatting

**Files:** `src/bot/formatter/messages.ts`

**Interfaces:**
- Produces: `formatHeading(title)`, `formatLines(title, lines)`, `formatHelpMessage()`, `formatUserFriendlyError()`.

- [x] **Step 1: Write the formatter helpers**

`formatHeading` wraps a title in Markdown bold (`*title*`); `formatLines`
joins a heading and an array of lines with `\n`; `formatHelpMessage`
lists every slash command plus a natural-language hint
("Or just message me naturally, like..."); `formatUserFriendlyError`
returns a single friendly line ("Oops — something hiccupped...") used
by both the error middleware and `buildAssistantReply`'s
`serviceError` branch.

*(`/digest` was appended to this help list later, once PLUTO-06 added that command — not part of this module's original scope.)*

---

### Task 3: Auth and error middleware

**Files:** `src/bot/middleware/auth.ts`, `src/bot/middleware/error.ts`

**Interfaces:**
- Produces: `authMiddleware(ctx, next)`, `errorHandlerMiddleware(ctx, next)`.

- [x] **Step 1: `authMiddleware`**

Reads `config.TELEGRAM_AUTHORIZED_CHAT_ID`; if unset, calls `next()`
unconditionally (open access). Otherwise compares `String(ctx.chat?.id)`
against it; on mismatch, replies with a lockout message and does
**not** call `next()` (silently dropping the update from the bot's
perspective — no error is thrown).

- [x] **Step 2: `errorHandlerMiddleware`**

Wraps `next()` in try/catch; on any thrown error, `logger.error(...)`
then `ctx.reply(formatUserFriendlyError())`. Registered after
`authMiddleware` so an auth rejection doesn't need to pass through
error handling, but before every command/message handler so any
handler-level throw is caught.

- [x] **Step 3: Verify**

Manual: message from an unauthorized chat gets the lockout reply, not
routed to any handler; a handler that throws (e.g. temporarily forced)
gets the generic error reply instead of crashing the process.

---

### Task 4: Command handlers (initial placeholders)

**Files:** `src/bot/commands/{portfolio,today,month,budget,export,undo,help}.ts`, `src/bot/commands/index.ts`

**Interfaces:**
- Produces: `handlePortfolioCommand()`, `handleTodayCommand()`, `handleMonthCommand()`, `handleBudgetCommand()`, `handleExportCommand()`, `handleUndoCommand()`, `handleHelpCommand()` — each `(): Promise<string>`.

- [x] **Step 1: Write each handler**

At initial scaffold (before PLUTO-03 existed), `today`/`month`/`export`/
`undo` returned hardcoded placeholder strings identical in shape to
`portfolio`'s and `budget`'s permanent placeholders. `help` was real
from the start (`formatHelpMessage()`).

- [x] **Step 2: Barrel export**

`src/bot/commands/index.ts` re-exports all seven (later eight, once
`/digest` is added by PLUTO-06) via `export * from './<name>'`.

- [x] **Step 3: Wire real data once the expense engine exists (PLUTO-03)**

Once `src/expense/index.ts` exported `getSpendingSummary`, `exportCSV`,
and `undoLastTransaction`, `today.ts`/`month.ts`/`export.ts`/`undo.ts`
were rewritten to call them directly (no dynamic import needed here —
these are top-level command handlers, not `ai.ts`'s intent switch, so
there's no circularity concern). `portfolio.ts` and `budget.ts` stay
placeholders, pending PLUTO-04 and PLUTO-05 respectively (`budget.ts`
was rewritten once PLUTO-05 landed — see that module's plan).

---

### Task 5: Gemini intent classification and reply generation

**Files:** `src/bot/ai.ts`, `src/bot/ai.test.ts`

**Interfaces:**
- Produces: `ExtractedFields`, `IntentAnalysis`, `classifyUserMessage(rawText): Promise<IntentAnalysis>`, `buildAssistantReply(result): Promise<string>`.

- [x] **Step 1: Write the failing tests**

`src/bot/ai.test.ts`: assert `buildAssistantReply` renders the amount/
merchant/category into the `expense` acknowledgement; assert it
returns the generic error message (matching `/hiccupped/i`) when
`serviceError` is set; assert `classifyUserMessage` degrades to
`{ intent: 'unknown', serviceError: true }` when `global.fetch` is
stubbed to throw; a real-Gemini-call test gated behind
`RUN_LIVE_AI_TESTS=1` (`{ skip: !process.env.RUN_LIVE_AI_TESTS && '...' }`).

- [x] **Step 2: Implement `classifyUserMessage`**

Empty/whitespace input short-circuits to a non-error `unknown` (no
Gemini call). Otherwise: construct `GoogleGenerativeAI`, a
`getGenerativeModel` call with a system instruction describing the
JSON contract (`intent`, `confidence`, `extracted {...}`, `rawText`),
race `model.generateContent(prompt)` against a timeout promise,
`safeJsonParse` the response text (extract the outermost `{...}` span,
`JSON.parse`, `null` on failure), and either build a validated
`IntentAnalysis` (clamping `confidence` to `[0,1]`) or return
`gracefulUnknown(trimmed)`. Any thrown error (network, timeout) is
caught and also degrades to `gracefulUnknown`.

*(Initial version pinned `gemini-1.5-flash` with a 5s timeout and — at
this stage — no `GOOGLE_API_KEY` requirement, falling back to a
`fallbackPatterns` regex table when the key was absent or a call
failed. This was removed in a later hardening pass; see Task 6.)*

- [x] **Step 3: Implement `buildAssistantReply`**

Checks `serviceError` first. Then switches on `intent`:
`expense`/`recurring`/`query` return templated strings referencing
extracted fields but call nothing (no expense engine yet);
`correction` dynamically imports `correctLastTransaction` — the first
case wired to a real (as-yet-unbuilt-at-this-exact-moment, landed with
PLUTO-03) domain function, establishing the dynamic-import convention
every later wired case follows; `help` returns a static command
summary; `default` handles anything else.

- [x] **Step 4: Run tests, verify, commit**

Run: `npx tsx --test src/bot/ai.test.ts` — passes (network-free tests
by default). Register the file in `package.json`'s `test` script.

---

### Task 6: Harden Gemini usage — require the API key, drop the regex fallback, fix the model id

*(Later hardening pass, same week as PLUTO-03's initial build — landed alongside `doc/tasks/01`/`02` annotation updates and a new `CLAUDE.md`.)*

**Files:** `src/config/env.ts`, `src/bot/ai.ts`, `src/bot/ai.test.ts`

- [x] **Step 1: Make `GOOGLE_API_KEY` a hard requirement**

`env.ts`: `GOOGLE_API_KEY: z.string().min(1, 'GOOGLE_API_KEY is required — Pluto AI classifies every message with Gemini and has no rule-based fallback')` — no `.optional()`, no default. Startup now fails immediately (via the existing `ZodError` → `process.exit(1)` path) if the key is missing.

- [x] **Step 2: Delete the regex fallback**

Remove `fallbackPatterns`, `fallbackIntentAnalysis`, and
`extractFieldsFromText` entirely from `ai.ts`. Remove the
`if (!config.GOOGLE_API_KEY) return fallbackIntentAnalysis(trimmed);`
branch — it's now unreachable anyway (env validation guarantees the
key exists) but the surrounding logic is simplified to reflect that.

- [x] **Step 3: Add `serviceError` and `gracefulUnknown`**

Introduce the `serviceError?: boolean` field on `IntentAnalysis` and a
`gracefulUnknown(rawText)` helper that's the single return path for
any Gemini failure (timeout, network error, unparseable JSON).
`buildAssistantReply` checks `result.serviceError` first and returns
`formatUserFriendlyError()` before reaching the intent switch.

- [x] **Step 4: Fix the pinned model id and widen the timeout**

`gemini-1.5-flash` → (having already been bumped once to
`gemini-2.5-flash`, also since deprecated) → `gemini-3.6-flash`; timeout
`5000` → `15000` ms, since this model's reasoning overhead alone
approaches 5s for the classification prompt.

- [x] **Step 5: Update tests**

Rewrite the "Gemini call fails" test to assert `intent === 'unknown'`
and `serviceError === true` (previously it would have asserted a
regex-guessed intent). Add the gated live-API test.

- [x] **Step 6: Verify and commit**

Run: `npx tsx --test src/bot/ai.test.ts` — passes without network. Add
`CLAUDE.md` documenting this as a hard project rule so it isn't
reintroduced later.

---

### Task 7: Free-text and voice message handlers

**Files:** `src/bot/handlers/text.ts`, `src/bot/handlers/voice.ts`

**Interfaces:**
- Produces: `handleTextMessage(message: string): Promise<string>`, `classifyIntent(message): Promise<{intent, confidence, text}>` (thin wrapper, used for logging/debugging), `handleVoiceMessage(voiceFileId: string): Promise<string>`.

- [x] **Step 1: `text.ts`**

`handleTextMessage` calls `classifyUserMessage`, logs the classification
at debug level, then returns `buildAssistantReply(classification)`.

- [x] **Step 2: `voice.ts`**

`handleVoiceMessage(_voiceFileId)` logs receipt and returns a fixed
string explaining that transcription isn't connected yet. Deliberately
does not download the file or call any speech-to-text API — scoped out
of this module (see spec's Out of scope).

---

### Task 8: `PlutoBot` — wiring middleware, commands, and message handlers

**Files:** `src/bot/index.ts`

**Interfaces:**
- Produces: `class PlutoBot { constructor(); start(): Promise<void>; stop(): Promise<void>; getBot(): Bot }`, `export const bot: PlutoBot`.

- [x] **Step 1: Constructor**

Throws if `config.TELEGRAM_BOT_TOKEN` is unset; otherwise constructs
`new Bot(token)`.

- [x] **Step 2: `start()`**

Registers `authMiddleware` then `errorHandlerMiddleware` via
`this.bot.use(...)`; registers one `this.bot.command(...)` per slash
command (`portfolio`, `today`, `month`, `budget`, `export`, `undo`,
`help`, plus a native `start` command replying with the help message);
registers `this.bot.on('message:text', ...)` →
`handleTextMessage(ctx.message.text)` and
`this.bot.on('message:voice', ...)` →
`handleVoiceMessage(String(voice.file_id))`; finally
`await this.bot.start({ drop_pending_updates: true })` (long polling).

- [x] **Step 3: `stop()` and `getBot()`**

`stop()` calls `this.bot.stop()`. `getBot()` returns the raw grammy
`Bot` — added so later modules (schedulers, webhook) can send
messages via `bot.api.sendMessage(...)` without needing a `PlutoBot`
reference (`/digest` command registration was appended here later by
PLUTO-06, following the same pattern as the other commands).

- [x] **Step 4: Verify**

Manual: `npm run dev` with a real `TELEGRAM_BOT_TOKEN` — bot responds
to `/help`, free text gets classified and replied to, an unauthorized
chat gets the lockout message.

---

### Task 9: Wire into the application entry point

**Files:** `src/index.ts`, `package.json`

- [x] **Step 1: Construct and start conditionally**

`src/index.ts`: `if (config.TELEGRAM_BOT_TOKEN) { plutoBot = new PlutoBot(); plutoBot.start().catch(...) }` — not awaited, since grammy's long-polling `start()` never resolves during normal operation and would otherwise block every subsequent boot step (recurring scheduler, digest scheduler, webhook server — added by later modules) from running. Logs a warning and continues with `plutoBot = null` if the token is absent.

- [x] **Step 2: Register the test file**

`package.json`'s `test` script includes `src/bot/ai.test.ts` as the first entry.

- [x] **Step 3: Full verification**

Run: `npm test` (passes, network-free), `npm run dev` (bot starts, responds), `npx tsc --noEmit` (no type errors).
