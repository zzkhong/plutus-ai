# PLUTO-07: iOS Shortcut Integration

| Field | Value |
|-------|-------|
| Module | iOS Shortcut Integration |
| Priority | P0 — Critical Path |
| Dependencies | PLUTO-01 (Foundation), PLUTO-03 (Expense Engine) |
| Estimated effort | Small |

---

## Description

The primary input channel for Pluto AI. An HTTP webhook endpoint
receives Apple Pay transaction data from an iOS Shortcut automation,
processes it through the Expense Engine, and sends a confirmation to the
user via Telegram. This captures ~90% of daily transactions with zero
manual effort.

---

## Acceptance Criteria

**Status: not started.** No `src/webhook/` directory exists, and there is
no HTTP server usage anywhere in `src/` despite `hono` being a dependency.
None of the criteria below are implemented.

- [ ] HTTP POST endpoint accepts transaction data from iOS Shortcut
- [ ] Endpoint is secured (API key or shared secret in header)
- [ ] Payload includes: amount, merchant name, card name used
- [ ] Card name is mapped to currency via configured mapping
- [ ] Transaction is logged via the Expense Engine
- [ ] Confirmation message sent to user via Telegram:
      "Spent $4.50 at Ya Kun — Food"
- [ ] Response time < 3 seconds from webhook to Telegram confirmation
- [ ] If webhook fails, iOS Shortcut shows an error (user knows to
      log manually)
- [ ] iOS Shortcut template documented for user to set up

---

## Technical Scope

### Components

| Component | Responsibility |
|-----------|---------------|
| Webhook server | HTTP endpoint (Hono/Express) |
| Auth middleware | Validate API key/secret |
| Payload parser | Extract amount, merchant, card from request |
| Card resolver | Map card name → currency |
| Confirmation sender | Send Telegram message after logging |

### Files to Create

```
src/webhook/
├── index.ts              # HTTP server setup
├── routes/
│   └── apple-pay.ts      # POST /api/apple-pay handler
├── auth.ts               # API key validation middleware
└── types.ts              # Webhook payload types

docs/
└── ios-shortcut-setup.md # User guide for setting up the automation
```

### Webhook Payload

```json
POST /api/apple-pay
Headers: { "x-api-key": "configured-secret" }

{
  "amount": "4.50",
  "merchant": "Ya Kun Kaya Toast",
  "card": "DBS Visa"
}
```

### Response

```json
200 OK
{
  "status": "logged",
  "transaction": {
    "amount": 4.50,
    "currency": "SGD",
    "merchant": "Ya Kun Kaya Toast",
    "category": "Food"
  }
}
```

### iOS Shortcut Design

The iOS Shortcut automation:
1. **Trigger:** "When Apple Pay is used" (Shortcuts automation)
2. **Actions:**
   - Get transaction amount (from automation input)
   - Get merchant name (from automation input)
   - Get card name (from automation input)
   - Make HTTP POST to webhook URL with the data
3. **Error handling:** If HTTP request fails, show notification
   "Pluto: Failed to log. Tell bot manually."

### Deployment Considerations

The webhook needs to be reachable from the internet. Options:
- **Cloudflare Tunnel** (free) — expose local server
- **ngrok** (free tier) — for development
- **Fly.io / Railway** (free tier) — if deploying to cloud
- **Home server + port forward** — if self-hosting

---

## Interface Contracts

### Exposes

```typescript
// HTTP endpoint
POST /api/apple-pay → logs transaction, returns confirmation

// Health check
GET /api/health → { status: 'ok' }
```

### Consumes

```typescript
// From Expense Engine (PLUTO-03)
logExpense(data: ExpenseInput): Promise<Transaction>

// From Foundation (PLUTO-01)
import { cardCurrencyMap } from '../config/currencies'

// From Bot (PLUTO-02) — for sending confirmation
sendMessage(text: string): Promise<void>
```

---

## Notes

- The webhook server can be the same HTTP server that hosts the
  Telegram webhook (if using webhook mode for the bot). Or a separate
  port — either works for single-user.
- API key is a simple shared secret. No need for OAuth or complex auth
  for a personal tool.
- iOS Shortcuts can pass the card name used for Apple Pay — this is
  how we determine currency without asking the user.
- If the amount contains a currency symbol from the POS terminal (e.g.
  "RM 45.00"), the currency resolver in Expense Engine handles it.
- Document the exact iOS Shortcut steps so the user can recreate it
  if they reset their phone.
