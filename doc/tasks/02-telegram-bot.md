# PLUTO-02: Telegram Bot Core

| Field | Value |
|-------|-------|
| Module | Telegram Bot Core |
| Priority | P0 — Critical Path |
| Dependencies | PLUTO-01 (Project Foundation) |
| Estimated effort | Medium |

---

## Description

Set up the Telegram bot that serves as the single conversational UI for
Pluto AI. This is not a rule-based message switchboard; it is a
chatbot-first interface that handles natural language, voice, and
slash commands, then delegates actual business logic to the Expense
Engine, Portfolio Tracker, and Budget System.

The bot should feel like a personal finance assistant, not a rigid bot
that responds with fixed canned phrases. Gemini should be used to
classify user intent, extract structured data, and generate natural,
context-aware replies.

---

## Acceptance Criteria

- [ ] Bot connects to Telegram and responds as a conversational AI assistant
- [ ] Command routing works for all defined commands (/portfolio,
      /today, /month, /budget, /export, /undo, /help)
- [ ] Free-text messages are sent to Gemini for intent classification,
      structured extraction, and natural-language response generation
- [ ] Voice messages are transcribed and processed as text before the
      same AI flow
- [ ] Bot responds with polished, contextual messages (Markdown or HTML)
- [ ] Error handling: graceful failures with user-friendly messages
- [ ] Bot ignores messages from non-authorized users (single-user
      security)

---

## Technical Scope

### Components

| Component | Responsibility |
|-----------|---------------|
| Bot setup | Token config, polling/webhook mode, middleware |
| Command router | Maps /commands to handler functions |
| Message handler | Classifies free-text intent, delegates to modules |
| Voice handler | Transcribes voice notes, passes to message handler |
| Response formatter | Consistent message formatting (spending, portfolio, etc.) |
| Auth guard | Rejects messages from unauthorized chat IDs |

### Files to Create

```
src/bot/
├── index.ts              # Bot initialization and startup
├── middleware/
│   ├── auth.ts           # Single-user auth guard (chat ID check)
│   └── error.ts         # Global error handler
├── commands/
│   ├── portfolio.ts      # /portfolio handler
│   ├── today.ts          # /today handler
│   ├── month.ts          # /month handler
│   ├── budget.ts         # /budget handler
│   ├── export.ts         # /export handler
│   ├── undo.ts           # /undo handler
│   └── help.ts           # /help handler
├── handlers/
│   ├── text.ts           # Free-text message processing
│   └── voice.ts          # Voice note transcription + processing
├── formatter/
│   └── messages.ts       # Response templates and formatting
└── types.ts              # Bot-specific types
```

### Intent Classification and Response Generation

The bot must distinguish between:
1. **Expense logging** — "Spent $4.50 at Ya Kun"
2. **Query** — "How much did I spend on food this month?"
3. **Budget command** — "Set food budget to $800/month"
4. **Correction** — "Last one was transport not food"
5. **Recurring setup** — "Log $2400 rent every 1st"

This classification and the final message generation are delegated to
Gemini through a system prompt that returns structured intent + extracted
fields, and then the app turns that into a natural-language response. The
bot should not rely on hardcoded if/else keyword matching for normal user
conversation — not as the primary path, and not as a silent fallback when
Gemini is unavailable. `GOOGLE_API_KEY` is a required environment variable
(startup fails without it); if a Gemini call itself fails at runtime
(timeout, network error, unparseable response), surface the existing
`formatUserFriendlyError()` message rather than guessing an intent from
keywords.

A model-driven workflow is required:
- classify the message
- extract fields like amount, merchant, category, period, or budget amount
- decide which domain module to call
- generate a conversational confirmation or summary back to the user

### Voice Handling

- Use Telegram's built-in voice message file download
- Transcribe via Gemini (multimodal — send audio directly) or a free
  speech-to-text API
- Once transcribed, treat as regular text input

---

## Interface Contracts

### Consumes (from other modules)

```typescript
// From Expense Engine (PLUTO-03)
logExpense(data: ExpenseInput): Promise<Transaction>
undoLastTransaction(): Promise<Transaction | null>
getSpendingSummary(period: 'today' | 'month'): Promise<SpendingSummary>

// From Portfolio Tracker (PLUTO-04)
getPortfolioSummary(): Promise<PortfolioSummary>

// From Budget System (PLUTO-05)
getBudgetStatus(): Promise<BudgetStatus[]>
setBudget(category: Category, amount: number): Promise<Budget>
```

### Exposes (for iOS Shortcut - PLUTO-07)

```typescript
// The bot instance for sending confirmations
sendMessage(text: string): Promise<void>
```

---

## Notes

- Use long polling for development, webhook mode for production.
- Authorized chat ID stored in environment variable.
- Voice transcription quality is best-effort; user can always re-type
  if transcription is wrong.
- Response time target: < 5 seconds for text, < 10 seconds for
  voice (includes transcription). In practice `gemini-3.6-flash`'s
  reasoning overhead alone runs close to 5s for the classification
  prompt used here, so the in-app request timeout is set to 15s to
  avoid misfiring as a service error — revisit the target if a faster
  model/prompt becomes available.
- Pin an explicit, current model id (currently `gemini-3.6-flash`) rather
  than an alias like `gemini-flash-latest`, so behavior doesn't drift
  silently when Google rotates the alias. Google deprecates model ids
  over time (`gemini-1.5-flash` and `gemini-2.5-flash` both returned 404
  as of 2026-08); check `GET /v1beta/models` against the configured
  `GOOGLE_API_KEY` if classification starts failing.
