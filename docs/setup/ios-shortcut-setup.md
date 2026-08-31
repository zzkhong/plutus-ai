# iOS Shortcut Setup — Apple Pay Webhook

This sets up an iOS Shortcuts automation that fires every time you pay with
Apple Pay, sends the transaction to Pluto AI's webhook, and logs it
automatically — no manual entry.

## 1. Configure the webhook

1. In `.env`, set a secret value for `WEBHOOK_API_KEY` (any long random
   string works — see `.env.example`).
2. Start the app (`npm run dev` or `npm start`). On boot you should see:
   ```
   Webhook server listening on port 3000
   ```
   If instead you see `Webhook server not started: WEBHOOK_API_KEY is not
   configured`, the endpoint is disabled — fix `.env` and restart.
3. Confirm it's reachable locally:
   ```
   curl http://localhost:3000/api/health
   # {"status":"ok"}
   ```

## 2. Expose it to the internet with a Cloudflare Tunnel

This uses a **quick tunnel** — no Cloudflare account or domain required.
The tradeoff: the public URL is random and changes every time you restart
the tunnel, so you'll need to re-paste it into the Shortcut when that
happens. That's an acceptable tradeoff for a single-user personal tool; a
named tunnel (stable URL, needs a Cloudflare account + domain) is a
possible future upgrade.

1. Install `cloudflared`:
   - macOS: `brew install cloudflared`
   - Windows: `winget install --id Cloudflare.cloudflared`
   - Other platforms: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
2. With the app running locally, start the tunnel (adjust the port if you
   changed `PORT` in `.env`):
   ```
   cloudflared tunnel --url http://localhost:3000
   ```
3. `cloudflared` prints a public URL that looks like
   `https://random-words-here.trycloudflare.com`. That's your webhook base
   URL. Keep this terminal window open — closing it tears down the tunnel.
4. Verify from outside your network (e.g. cellular data on your phone):
   ```
   https://random-words-here.trycloudflare.com/api/health
   ```
   should return `{"status":"ok"}`.

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
   - URL: `https://random-words-here.trycloudflare.com/api/apple-pay`
     (your tunnel URL from step 2, plus `/api/apple-pay`)
   - Method: `POST`
   - Headers:
     - `Content-Type`: `application/json`
     - `x-api-key`: the same value as `WEBHOOK_API_KEY` in `.env`
   - Request Body: **JSON**, with fields:
     - `amount`: the transaction amount (from the Apple Pay automation's
       "Transaction Amount" magic variable)
     - `merchant`: the transaction merchant (from "Transaction Merchant")
     - `card`: the card used (from "Transaction Card" — this determines the
       currency via the card→currency mapping in
       [src/config/currencies.ts](../src/config/currencies.ts))
3. **If** (Get Contents of URL fails / errors)
   - **Show Notification**: "Pluto: Failed to log. Tell bot manually."

Save the automation. Make a small Apple Pay purchase to test — you should
get a Telegram message like `Spent $4.50 at Ya Kun — Food` within a few
seconds.

## 4. Re-pasting the URL after a restart

Every time you restart `cloudflared`, the `*.trycloudflare.com` URL
changes. When that happens:

1. Note the new URL printed by `cloudflared tunnel --url ...`.
2. Open the Shortcut automation → the **Get Contents of URL** action →
   update the URL field.

## Troubleshooting

- **No Telegram confirmation, but the shortcut didn't show an error**: check
  `TELEGRAM_AUTHORIZED_CHAT_ID` is set in `.env` — the transaction is still
  logged even if the confirmation can't be sent (check `/today` in the bot).
- **401 from the webhook**: `x-api-key` header doesn't match
  `WEBHOOK_API_KEY` in `.env`.
- **Webhook unreachable from outside**: confirm the `cloudflared` process is
  still running and the URL in the Shortcut matches what it's currently
  printing.
