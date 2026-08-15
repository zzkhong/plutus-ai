# PLUTO-02: Telegram Bot Core

| Field | Value |
|-------|-------|
| Module | Telegram Bot Core |
| Priority | P0 — Critical Path |
| Dependencies | PLUTO-01 (Project Foundation) |
| Estimated effort | Medium |

---

## Description

Set up the Telegram bot that serves as the single UI for Pluto AI.
Handles incoming messages (text and voice), routes commands, and formats
responses. This module is the communication layer — it delegates actual
business logic to the Expense Engine, Portfolio Tracker, and Budget
System.

---

## Acceptance Criteria

- [ ] Bot connects to Telegram and responds to messages
- [ ] Command routing works for all defined commands (/portfolio,
      /today, /month, /budget, /export, /undo, /help)
- [ ] Free-text messages are forwarded to the AI intent classifier
- [ ] Voice messages are transcribed and processed as text
- [ ] Bot responds with formatted messages (Markdown or HTML)
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

### Intent Classification

The bot must distinguish between:
1. **Expense logging** — "Spent $4.50 at Ya Kun"
2. **Query** — "How much did I spend on food this month?"
3. **Budget command** — "Set food budget to $800/month"
4. **Correction** — "Last one was transport not food"
5. **Recurring setup** — "Log $2400 rent every 1st"

This classification is delegated to Gemini with a system prompt that
returns a structured intent + extracted data.

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
  voice (includes transcription).
