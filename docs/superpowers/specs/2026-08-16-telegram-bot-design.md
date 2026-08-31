# PLUTO-02: Telegram Bot Core — Design

Source requirements: [docs/tasks/02-telegram-bot.md](../../tasks/02-telegram-bot.md)

## Goal

A single conversational Telegram UI (via grammy) that routes slash
commands to handler functions, classifies free-text messages through
Gemini into a structured intent, and replies in natural language —
with no keyword/regex intent matching as a primary path or a silent
fallback when Gemini is unavailable.

## Scope decisions (resolved during initial implementation)

- **Gemini-first, no rule-based fallback — enforced, not just
  documented.** The bot originally shipped with a `fallbackPatterns`
  regex table in `src/bot/ai.ts` that classified intent by keyword
  (`spent|expense|log|paid` → `expense`, `budget|limit` → `budget`,
  etc.) whenever `GOOGLE_API_KEY` was unset. This was deliberately
  removed: `env.ts`'s `GOOGLE_API_KEY` became a hard-required field
  (`z.string().min(1, ...)`, no default), and a runtime Gemini failure
  now returns `{ intent: 'unknown', serviceError: true }` instead of
  guessing via regex. `buildAssistantReply` checks `serviceError` first
  and returns the generic `formatUserFriendlyError()` message before
  it ever reaches the intent `switch`. This is a hard project rule,
  not a style preference — re-adding keyword matching as a fallback
  regresses a decision that was explicitly tried and reverted.
- **Pinned, explicit Gemini model id.** The classification model has
  been pinned three times over the module's life
  (`gemini-1.5-flash` → `gemini-2.5-flash` → `gemini-3.6-flash`), each
  time because Google deprecated the previous id (`GET /v1beta/models`
  returning 404 for it). An alias like `gemini-flash-latest` was
  considered and rejected — an alias could silently change behavior
  underneath the app without a code change to review. If
  classification starts failing, checking the models endpoint against
  the configured key is the first debugging step, documented directly
  in the task doc's Notes.
- **Classification timeout widened from 5s to 15s.** The original
  timeout (5s) was tuned before `gemini-3.6-flash` was pinned; that
  model's reasoning overhead alone routinely approaches 5s for this
  classification prompt, so 5s was misfiring as a service error under
  normal conditions. 15s gives enough headroom; the task doc's "< 5s
  response time" target is noted as aspirational pending a faster
  model/prompt.
- **Structured JSON contract between Gemini and the app.** The system
  instruction asks for strict JSON (`intent`, `confidence`, `extracted
  { amount, merchant, category, period, budgetAmount, action }`,
  `rawText`); `safeJsonParse` extracts the outermost `{...}` span and
  `JSON.parse`s it, returning `null` (→ graceful-unknown) on any
  parse failure rather than throwing. `confidence` is clamped to
  `[0, 1]` defensively even though the model is asked to return a
  0–1 value.
- **`buildAssistantReply` is the single place domain modules get
  invoked from chat**, via dynamic `import()` per intent case (avoids
  import-order/circularity issues between `src/bot/` and domain
  modules). At the time this module was built, only `correction` was
  wired this way (`await import('../expense/service')` →
  `correctLastTransaction`); `expense`, `budget`, `recurring`, and
  `query` were canned strings acknowledging the message without
  calling anything, because the expense engine (PLUTO-03), portfolio
  tracker (PLUTO-04), and budget system (PLUTO-05) didn't exist yet
  when the bot skeleton was first built on 2026-08-16. The `expense`
  intent is still unwired as of this writing (see Out of scope) —
  `budget` was wired later, once PLUTO-05 landed, using the same
  dynamic-import pattern established here.
- **Auth is a single-chat allowlist, not a user system.** `authMiddleware`
  compares `ctx.chat?.id` against `config.TELEGRAM_AUTHORIZED_CHAT_ID`
  as strings; if the env var is unset, auth is a no-op (any chat is
  "authorized") — acceptable for a personal single-user tool where the
  bot token itself is the real secret, but worth remembering if this
  bot is ever exposed more broadly.
- **Errors degrade to one generic message.** `errorHandlerMiddleware`
  wraps the entire command/message pipeline in try/catch; any thrown
  error is logged and answered with `formatUserFriendlyError()` — the
  user never sees a stack trace or raw error string from Telegram.
- **Voice is a stub, on purpose, not an oversight.** `handleVoiceMessage`
  receives the voice `file_id`, logs it, and returns a fixed
  "transcription will be processed... once the speech-to-text layer is
  connected" string. It never downloads the file or calls Gemini's
  multimodal audio input. This was scoped out to ship the rest of the
  bot core first; see Out of scope.

## Module layout

```
src/bot/
├── index.ts                  # PlutoBot class: constructs grammy Bot, wires middleware + commands
├── types.ts                  # BotIntent, CommandName, BotCommandResponse
├── ai.ts                     # classifyUserMessage (Gemini), buildAssistantReply (intent -> text)
├── ai.test.ts                # Tests for both, network-free by default
├── middleware/
│   ├── auth.ts               # authMiddleware — single-chat allowlist
│   └── error.ts              # errorHandlerMiddleware — catch-all -> formatUserFriendlyError()
├── commands/
│   ├── portfolio.ts          # handlePortfolioCommand — hardcoded placeholder (PLUTO-04 stub)
│   ├── today.ts              # handleTodayCommand — getSpendingSummary('today')
│   ├── month.ts              # handleMonthCommand — getSpendingSummary('month')
│   ├── budget.ts             # handleBudgetCommand — placeholder until PLUTO-05 wires it
│   ├── export.ts             # handleExportCommand — exportCSV(currentYear)
│   ├── undo.ts                # handleUndoCommand — undoLastTransaction()
│   ├── help.ts                # handleHelpCommand — formatHelpMessage()
│   └── index.ts               # barrel export
├── handlers/
│   ├── text.ts                # handleTextMessage — classify then reply
│   └── voice.ts               # handleVoiceMessage — stub, see scope decisions
└── formatter/
    └── messages.ts             # formatHeading/formatLines/formatHelpMessage/formatUserFriendlyError
```

### `ai.ts`

```typescript
interface ExtractedFields {
  amount?: number; merchant?: string; category?: string;
  period?: string; budgetAmount?: number; action?: string;
}

interface IntentAnalysis {
  intent: BotIntent; confidence: number; extracted: ExtractedFields;
  rawText: string; serviceError?: boolean;
}

classifyUserMessage(rawText: string): Promise<IntentAnalysis>
buildAssistantReply(result: IntentAnalysis): Promise<string>
```

`classifyUserMessage`: trims input (empty string short-circuits to a
non-error `unknown` with confidence 0, no Gemini call); otherwise
constructs a `GoogleGenerativeAI` client with a fixed system
instruction, races `model.generateContent(prompt)` against a 15s
timeout, and either parses the JSON response into an `IntentAnalysis`
or returns `gracefulUnknown(trimmed)` — the single degraded-response
path, used for timeouts, network errors, and unparseable JSON alike.

`buildAssistantReply`: returns `formatUserFriendlyError()` immediately
if `serviceError` is set; otherwise switches on `intent`. As of this
module's initial build, `expense`, `recurring`, and `query` return
templated acknowledgement strings that reference the extracted fields
but don't call any domain module; `correction` dynamically imports
`correctLastTransaction` from the expense engine (added once PLUTO-03
existed) and updates the most recent transaction; `help` returns a
static command list; the `default` case handles any unrecognized
intent string.

### `types.ts`

```typescript
type BotIntent = 'expense' | 'query' | 'budget' | 'correction' | 'recurring' | 'help' | 'unknown';
type CommandName = 'portfolio' | 'today' | 'month' | 'budget' | 'export' | 'undo' | 'help';
interface BotCommandResponse { command: CommandName; text: string; }
```

### `index.ts` — `PlutoBot`

```typescript
class PlutoBot {
  constructor() // throws if TELEGRAM_BOT_TOKEN is unset
  start(): Promise<void>   // wires middleware, commands, message handlers, starts long polling
  stop(): Promise<void>
  getBot(): Bot             // exposes the raw grammy Bot for schedulers to send through
}
export const bot = new PlutoBot();
```

`start()` registers, in order: `authMiddleware`, `errorHandlerMiddleware`,
then one `this.bot.command(name, ...)` per slash command
(`portfolio`, `today`, `month`, `budget`, `export`, `undo`, `help`,
plus `start` for the Telegram-native `/start`), then
`this.bot.on('message:text', ...)` → `handleTextMessage` →
`buildAssistantReply`, and `this.bot.on('message:voice', ...)` →
`handleVoiceMessage`. Uses `bot.start({ drop_pending_updates: true })`
(long polling) — no webhook mode for the Telegram side (that term is
reserved for the unrelated iOS Shortcut HTTP webhook built in PLUTO-07).
`getBot()` is what later modules (recurring scheduler's alert
delivery, daily digest, the Apple Pay webhook's confirmation message)
use to send messages without depending on `PlutoBot` itself — see
Wiring below.

## Data model

No schema changes — this module is pure application logic on top of
PLUTO-01's types and (once it exists) PLUTO-03's expense service.

## Wiring into the rest of the app

`src/index.ts` constructs `new PlutoBot()` only if
`config.TELEGRAM_BOT_TOKEN` is set (otherwise logs a warning and
continues — the rest of the app, e.g. schedulers and the webhook
server, functions without a running Telegram bot, just without a
delivery channel for messages). `plutoBot.start()` is deliberately
**not awaited** — grammy's long-polling `start()` doesn't resolve
until the bot stops, so awaiting it would block every line after it
(scheduler startup, webhook server startup) from ever running.
`plutoBot.getBot()` is passed into `startRecurringScheduler`/
`triggerRecurringNow` (PLUTO-03/05) and `startDigestScheduler`
(PLUTO-06) so they can push messages through the same bot instance;
`null` is passed instead when the token isn't configured, and each
consumer is expected to skip delivery with a logged warning rather
than throw.

## Testing

`src/bot/ai.test.ts` (registered in `package.json`'s `test` script),
using `process.env.DATABASE_URL` pointed at a scratch file and a
`before()` hook calling `runMigrations()` (needed because the
`correction`/`budget` cases in `buildAssistantReply` touch the
database):

- `buildAssistantReply` renders the amount/merchant/category into the
  `expense` intent's acknowledgement string.
- `buildAssistantReply` returns the generic error message (not a
  guessed intent) when `serviceError` is set.
- `classifyUserMessage` against a real Gemini call returns `expense`
  for "Spent $4.50 at Ya Kun" — **skipped by default**
  (`RUN_LIVE_AI_TESTS=1` opts in; costs real API credits and needs
  network + a working key).
- `classifyUserMessage` degrades to `{ intent: 'unknown', serviceError:
  true }`, not a guessed intent, when `global.fetch` is stubbed to
  throw — runs by default, no network needed.
- (Added once PLUTO-05 landed) `buildAssistantReply`'s `budget` case:
  sets a real budget, removes a budget on a removal phrase, and asks
  for a category when none is extracted.

No dedicated test file for `PlutoBot`/`index.ts`, the command handlers,
or `handleTextMessage`/`handleVoiceMessage` — these are thin
orchestration with no branching logic worth a unit test beyond what
`ai.test.ts` already covers; verified manually via `npm run dev` and
sending real Telegram messages.

## Out of scope

- **Voice transcription.** `handleVoiceMessage` never downloads the
  Telegram voice file or calls a speech-to-text API (Gemini
  multimodal or otherwise) — it returns a fixed placeholder string.
  The task doc's acceptance criterion for this is explicitly left
  unchecked.
- **Wiring the `expense` intent to `logExpense`.** Free-text expense
  messages ("Spent $4.50 at Ya Kun") are classified correctly but only
  produce an acknowledgement string — they never persist a
  transaction. Only `/today`, `/month`, `/export`, `/undo`, and (once
  built) the iOS Shortcut webhook actually call into the expense
  engine. This is a known, tracked gap (see `CLAUDE.md`), not an
  oversight of this module.
- **`recurring` and `query` intents** similarly return canned
  acknowledgement strings rather than calling `createRecurring` or the
  spending-query functions — recurring transaction management has no
  chat or command surface at all as of PLUTO-03 (see that module's
  design doc).
- **`/portfolio`** is a hardcoded placeholder string
  (`handlePortfolioCommand`) — the portfolio tracker (PLUTO-04) didn't
  exist when this module was built and still doesn't as of PLUTO-07.
- **Webhook (HTTP) mode for the Telegram bot itself** — long polling
  only; no `setWebhook` call or HTTP endpoint for Telegram updates.
