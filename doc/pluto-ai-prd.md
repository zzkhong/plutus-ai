# Pluto AI - Product Requirements Document

## 1. Vision

A personal finance assistant that lives in Telegram. Expenses are
captured automatically via Apple Pay with minimal manual effort, and
the bot provides a nightly snapshot of spending plus portfolio health
— all at zero cost.

**Target user:** A Singapore-based professional who pays almost
exclusively via Apple Pay, holds investments across US and Malaysian
markets plus some crypto, and wants clear financial visibility without
spreadsheets or multiple apps.

---

## 2. Problem Statement

| Pain | Current workaround |
|------|--------------------|
| 90% of payments are Apple Pay but nothing logs them | Scroll bank app end of month |
| Multi-currency confusion (SGD/MYR/USD) | Manual Google conversion |
| No single view of net worth across stocks, cash, crypto | Multiple brokerage apps + spreadsheets |
| No sense of daily spending health | End-of-month surprise |

---

## 3. Core User Flows

### 3.1 Automatic Expense Logging (Primary)

**Trigger:** User taps Apple Pay (in Singapore or Malaysia).

**What happens:**
- iOS Shortcut fires on Apple Pay transaction
- Sends amount + merchant to the bot automatically
- Bot categorizes it and confirms in chat:
  "Spent $4.50 at Ya Kun — Food"
- User sees this message and knows the system is working

**The confirmation IS the failsafe:**
- Bot responds = transaction logged, all good
- Bot doesn't respond = hook didn't fire, user knows immediately
- User then manually texts: "Spent $4.50 at Ya Kun" as fallback
- This way nothing slips through silently

**Currency detection via card:**
- iOS Shortcut passes the card name used for payment
- Card-to-currency mapping (configured once):
  e.g. "DBS Visa" = SGD, "Maybank Mastercard" = MYR
- Correct currency is assigned regardless of physical location
- If user taps SG card in Malaysia, it logs as SGD (matches statement)

**Fallback for non-Apple-Pay payments (~10%):**
- Text the bot naturally: "Grabbed RM45 petrol at Shell"
- Or send a voice note describing the spend

**Key behaviors:**
- Understand casual Singlish/Malaysian context ("kopi" = Food,
  "grab" = Transport)
- Auto-detect currency from merchant location or explicit mention
- All amounts normalized to SGD
- Bot always confirms with: amount, merchant, and its category guess
- Corrections via chat: "Last one was transport not food" or /undo

---

### 3.2 Daily Financial Digest (Push)

**Trigger:** Every night at 10 PM automatically.

**Message contains:**
- Total spent today, broken down by category
- Budget status (if budgets are set)
- Portfolio net worth in SGD
- Notable stock/crypto price movements
- Short, friendly, no fluff

**Example:**
```
Daily Digest - 6 Aug

Spent today: $47.30
  Food: $22.80 (3 txns)
  Transport: $24.50 (2 txns)

Budget: Food 62% used (19 days left)

Net Worth: $XX,XXX SGD
  Stocks: +0.8% today
  BTC: $63,200 (+1.2%)

All good. Spending on track.
```

---

### 3.3 Ask Anything (Pull)

**Trigger:** User asks a question in chat.

**Example queries:**
- "How much did I spend on food this month?"
- "What's my net worth right now?"
- "Show me my top 5 expenses this week"
- "How is my portfolio split between US and MY?"
- "Am I over budget on transport?"
- "Compare this month vs last month"

**Outcome:** AI answers using actual transaction and portfolio data,
not generic financial advice.

---

### 3.4 Portfolio Tracking

**What it tracks:**
- US stocks and ETFs (e.g. AAPL, VOO)
- Malaysian stocks (e.g. Maybank, CIMB on Bursa)
- Cash balances across banks and currencies
- Crypto: BTC, ETH, BETH (read-only market price — fixed holdings,
  no new buys)

**What it shows:**
- Total value in SGD
- Percentage allocation per asset class
- Currency exposure breakdown (SGD / MYR / USD / crypto)
- Daily movement summary in digest

**Crypto handling:** Holdings are fixed quantities entered once. The
bot fetches live prices for BTC, ETH, and BETH and includes their
SGD value in net worth calculations. No buy/sell tracking needed.

---

### 3.5 Budget Tracking

**Setup:** User sets budgets via chat: "Set food budget to $800/month"

**Behavior:**
- Alert when 80% of a category budget is reached
- Alert when budget is exceeded
- Show budget progress in daily digest
- Monthly reset on the 1st

---

## 4. Supported Currencies & Markets

| Currency | Use case |
|----------|----------|
| SGD | Base currency, daily expenses, net worth display |
| MYR | Malaysia expenses & Bursa stocks |
| USD | US stock holdings |
| BTC/ETH/BETH | Crypto (fixed holdings, price tracking only) |

All values normalized to SGD for unified reporting.

---

## 5. Input Channels

| Channel | Priority | Use case |
|---------|----------|----------|
| Apple Pay (iOS Shortcut) | Primary | Auto-captures ~90% of transactions |
| Telegram text | Secondary | Manual logging + queries |
| Telegram voice | Secondary | Hands-free logging |
| Commands | On-demand | Portfolio view, exports, corrections |

---

## 6. Key Commands

| Command | What it does |
|---------|-------------|
| (natural text) | Log an expense or ask a question |
| /portfolio | Show current net worth & allocation |
| /today | Today's spending summary |
| /month | This month's spending by category |
| /budget | Show budget status |
| /export 2025 | Download full year CSV |
| /undo | Delete last logged transaction |
| /help | List available commands |

---

## 7. Recurring Transactions

Users can set up auto-logged recurring entries:
- "Log $2400 rent every 1st of the month"
- "Log $15 Netflix every 15th"

These appear in the daily digest on the day they fire. Manage via
chat: "Pause rent" / "Remove Netflix" / "Show recurring".

---

## 8. AI Chatbot Limits

The AI (Google Gemini Flash) runs on a free tier with generous limits:

| Metric | Free allowance | Typical daily usage |
|--------|---------------|---------------------|
| Requests/day | 1,500 | ~30 (logging + queries + digest) |
| Requests/minute | 15 | 1-2 peak |

At normal personal use (<50 requests/day), the free tier is never
close to exhausted. No usage caps needed in V1.

---

## 9. Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| Monthly cost | $0 (free tier services only) |
| Response time | < 3 seconds for Apple Pay logging |
| Response time | < 5 seconds for text logging |
| Response time | < 10 seconds for complex queries |
| Availability | Best-effort (personal tool, not SLA-bound) |
| Data privacy | Self-hosted, no third-party access to financial data |
| Multi-user | Single user only (personal assistant) |

---

## 10. What This Is NOT

- Not a banking app (no account linking or real-time syncing)
- Not a trading platform (no buy/sell execution)
- Not a financial advisor (no "you should buy X" recommendations)
- Not multi-user or family-shared
- Not a replacement for proper accounting software

---

## 11. Success Criteria

The product works if:

1. Every Apple Pay transaction gets a visible confirmation (no silent failures)
2. Daily digest is genuinely useful (read daily, not ignored)
3. "What's my net worth?" returns an accurate answer within 10 seconds
4. User stops opening spreadsheets for financial visibility
5. Total infrastructure cost remains $0/month

---

## 12. Phasing

### Phase 1 (MVP)
- Apple Pay auto-logging via iOS Shortcut
- Telegram text/voice expense logging
- AI categorization and currency detection
- Daily digest at 10 PM
- Portfolio tracking (manual holdings entry)
- Crypto price tracking (BTC, ETH, BETH)
- Budget setting and alerts
- Basic Q&A on spending data
- Recurring transactions

### Phase 2 (Later)
- Broker CSV import for cost basis (Interactive Brokers, MooMoo, etc.)
- Unrealized P&L tracking per holding
- Export and tax reporting improvements

---

## 13. Decisions Made

| Question | Decision |
|----------|----------|
| Proactive nudges ("Did you eat out today?") | No — daily digest only |
| Apple Pay automation in V1? | Yes — primary input channel |
| Portfolio cost basis | Phase 2 — broker CSV import |
| Web dashboard | No — Telegram-only, no dashboard planned |
| Crypto tracking | Price-only for fixed holdings (BTC, ETH, BETH) |
| AI model | Google Gemini Flash (free tier, 1500 req/day) |
