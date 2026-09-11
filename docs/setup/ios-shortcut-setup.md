# iOS Shortcut Setup — Apple Pay Webhook

This sets up an iOS Shortcuts automation that fires every time you pay with
Apple Pay, sends the transaction to Pluto AI's webhook, and logs it
automatically — no manual entry.

## 1. Get your webhook key

The webhook is **per-user** — there is no shared secret. Every approved user
gets their own key when they finish `/setup`, and requests signed with it log
against that user's account.

1. Finish onboarding in the bot if you haven't — see
   [SETUP.md](../../SETUP.md).
2. Send **`/webhookkey`** to the bot. It replies with your key. Treat it
   like a password: anyone holding it can log expenses as you.

## 2. Know your webhook URL

**On Vercel (production)** the URL is your project's production domain plus
`/api/apple-pay`, for example:

```
https://plutus-ai.vercel.app/api/apple-pay
```

It's public HTTPS and never changes, so there is nothing else to set up. Use
the production domain from **Project → Domains**, not a per-deployment URL —
those sit behind Vercel's login by default.

Check it's reachable:

```
curl https://plutus-ai.vercel.app/api/health
# {"status":"ok"}
```

**Running the standalone process instead** (`npm run dev` / `npm start`), the
webhook listens on `http://localhost:3000`, which your phone can't reach. Expose
it with a Cloudflare quick tunnel — no account needed:

1. Install `cloudflared` (`brew install cloudflared`, or
   `winget install --id Cloudflare.cloudflared` on Windows).
2. With the app running, start `cloudflared tunnel --url http://localhost:3000`.
3. It prints a URL like `https://random-words-here.trycloudflare.com`; your
   webhook is that plus `/api/apple-pay`. Keep the terminal open — closing it
   tears the tunnel down, and a restart gives you a new URL to paste into the
   Shortcut.

## 3. Create the iOS Shortcut

Open the **Shortcuts** app on iPhone → **Automation** tab → **+** → **Create
Personal Automation** → **Apple Pay**.

- **When**: "Apple Pay is Used" (leave card/merchant filters open to catch
  everything).
- Turn off **"Ask Before Running"** so it fires silently in the background.

Add these actions, in order:

1. **Get Text from Input** — the automation passes the transaction as
   automation input; this lets later steps reference specific parts of it.
2. **Get Contents of URL**
   - URL: your webhook URL from step 2
   - Method: `POST`
   - Headers:
     - `Content-Type`: `application/json`
     - `x-api-key`: the key `/webhookkey` gave you
   - Request Body: **JSON**, with fields:
     - `amount`: the transaction amount (from the Apple Pay automation's
       "Transaction Amount" magic variable)
     - `merchant`: the transaction merchant (from "Transaction Merchant")
     - `card`: the card used (from "Transaction Card" — this determines the
       currency via the card→currency mapping in
       [src/config/currencies.ts](../../src/config/currencies.ts))
3. **If** (Get Contents of URL fails / errors)
   - **Show Notification**: "Pluto: Failed to log. Tell bot manually."

Save the automation. Make a small Apple Pay purchase to test — you should
get a Telegram message like `Spent $4.50 at Ya Kun — Food` within a few
seconds.

## Troubleshooting

- **No Telegram confirmation, but the shortcut didn't show an error**: the
  transaction is logged either way — check `/today` in the bot. The
  confirmation goes to the chat that owns the key.
- **401 from the webhook**: the `x-api-key` header doesn't match any user's
  key. Re-check with `/webhookkey`. A 401 *page* (HTML, not JSON) means you
  used a per-deployment Vercel URL — switch to the production domain.
- **403 from the webhook**: the key is valid but your account isn't
  approved yet — ask the admin to `/approve` you.
- **Tunnel unreachable (standalone only)**: confirm `cloudflared` is still
  running and the URL in the Shortcut matches what it's currently printing.
