# Plutus AI

**A personal finance assistant that lives in Telegram.** Tell it what you
spent, the way you'd text a friend, and it keeps your expenses and budgets in
order. No app to open, no forms to fill in.

```
You:     Spent $4.50 at Ya Kun
Plutus:  Logged S$4.50 at Ya Kun under Food.

You:     Grab 18
Plutus:  Logged S$18.00 at Grab under Transport.

         ⚠️ Transport budget alert: you've used 80% (S$161.00 / S$200.00) this month.

You:     How much have I spent on food this month?
Plutus:  This month's spend on Food: S$212.40 across 23 transactions.
         That's 42.5% of your S$500.00 budget, S$287.60 left.
```

Plutus is built for Singapore and Malaysia: it understands S$, RM and US$,
hawker centres and Grab rides, and it keeps everything in SGD for you.

---

## What it does

### Track every expense by just saying it

- **Type it, however you'd say it.** *"Spent $4.50 at Ya Kun"*, *"Grab 12.80"*,
  *"RM 45 at Kopitiam"*, *"lunch 8.50"*. Plutus works out the amount, the
  merchant and the category.
- **Or send a voice note.** Plutus transcribes it and handles it exactly like
  a typed message. Its reply starts with `Heard: "…"`, so you can see what it
  understood.
- **Categories are automatic.** Every expense lands in one of Food, Transport,
  Groceries, Entertainment, Bills, Health, Education, Travel, Shopping or
  Others.
- **Three currencies.** Spend in SGD, MYR or USD. Everything is also stored in
  SGD at that day's exchange rate, so your totals and budgets always add up,
  and the reply shows both: *"Logged RM45.00 (S$14.02) at Kopitiam under
  Food."*
- **Fix mistakes in plain words.** Your most recent expense can be corrected
  by saying *"actually that was $12"*, *"it was in ringgit"* or *"that was
  Transport"*. `/undo` removes it entirely.
- **Recurring charges log themselves.** *"Netflix $15.98 every 5th"* logs that
  charge on the 5th of every month. A charge on the 31st is logged on the
  last day of shorter months. *"Cancel my Netflix"* stops it.
- **Apple Pay, automatically** (optional). With an iOS Shortcut, every Apple
  Pay purchase is logged the moment you tap your phone. See
  [the Shortcut guide](docs/setup/ios-shortcut-setup.md).

### Stay on budget

- **Set a monthly budget per category**, in any of the three currencies:
  *"Set food budget to $500"*, *"Transport budget RM 300"*. Say it again to
  change the amount; *"remove my food budget"* deletes it.
- **Alerts when it matters.** When an expense takes a category past **80%**,
  and again past **100%**, of its budget, the alert comes with that expense's
  reply. Each alert fires once a month, and budgets start fresh on the 1st.
- **Check in any time.** `/budget` shows every budget at a glance:

  ```
  Budgets this month (18 days left):
  Food: S$212.40 of S$500.00 (42.5%), S$287.60 left
  Transport: S$214.00 of S$200.00 (107%), over by S$14.00
  ```

- **Ask about your spending.** *"How much did I spend today?"*, *"…in the last
  week?"*, *"…on transport this month?"* — or use `/today` and `/month` for a
  breakdown by category.

### A nightly digest

Around 10pm every night, Plutus sends a short summary of your day: what you
spent and on what, recurring charges it logged, how your budgets are doing,
and a take on your portfolio, with one line of advice written by AI. `/digest`
shows it on demand.

### And a few more things

- **Split a bill** — `/split`, send a photo of the receipt, then say *"split
  evenly between 3"* or *"Alice had the burger, I had the salad"*. Plutus
  reads the items, works out each person's share (tax and service charge
  included), and can log just your share as an expense.
- **Track your portfolio** — send any broker's statement **as a file** (PDF,
  screenshot or CSV) and your positions are imported at the statement's
  prices. Add crypto and cash in chat (*"I hold 0.5 BTC"*, *"cash SGD
  5000"*). `/portfolio` shows your net worth and where it sits.
- **Export your data** — `/export` sends you this year's transactions as a CSV
  file you can open in Excel or Google Sheets.

---

## Getting started

Plutus runs as a Telegram bot. Someone runs an instance of it, and you
register with that bot using your own free Google Gemini key, which is what
lets Plutus understand your messages.

1. **Get a Gemini API key.** It's free: go to
   [aistudio.google.com/apikey](https://aistudio.google.com/apikey), sign in
   and create a key.
2. **Open the bot** in Telegram and send **`/setup`**.
3. **Reply `gemini`** when it asks which provider to use.
4. **Paste your key.** Plutus checks it works, then deletes your message so
   the key doesn't stay in the chat. It's stored encrypted.
5. **Wait for approval.** The bot's admin gets a message to approve you, and
   you're told as soon as they do. (If you set up the bot yourself, you're the
   admin and are approved straight away.)

Then just start telling it what you spend. Send `/help` any time for the list
of commands.

**Want to run your own Plutus?** It runs free on Vercel and Turso;
[SETUP.md](SETUP.md) walks you through it step by step.

---

## Commands

| Command | What it does |
|---|---|
| `/today` | Today's spending by category |
| `/month` | This month's spending by category |
| `/budget` | How every budget is doing this month |
| `/undo` | Remove your most recent expense |
| `/export` | This year's transactions as a CSV file |
| `/digest` | Show tonight's digest now |
| `/split` | Split a bill from a receipt photo (`/cancel` stops it) |
| `/portfolio` | Net worth, allocation and holdings |
| `/webhookkey` | Your personal key for the Apple Pay Shortcut |
| `/setup` | Register, or change your Gemini key |
| `/help` | The command list |

You don't need commands for most things. Just say what you mean:

| You say… | Plutus… |
|---|---|
| "Spent $4.50 at Ya Kun" · "RM 45 at Kopitiam" · "Grab 12.80" | logs the expense and categorizes it |
| "Actually that was $12" · "it was in ringgit" · "that was Transport" | corrects your last expense |
| "How much did I spend this week?" · "…on food this month?" | tells you, with the budget if you have one |
| "Set food budget to $500" · "Remove my travel budget" | sets or removes a monthly budget |
| "Netflix $15.98 every 5th" · "Cancel my Spotify" | starts or stops a recurring charge |
| "I hold 0.5 BTC" · "cash SGD 5000" | adds a crypto or cash holding |
| a voice note saying any of the above | does the same |

---

## Good to know

- **Corrections and `/undo` apply to your most recent expense.** To fix an
  older one, undo back to it or correct it right after logging.
- **"This week" means the last 7 days**, and the answer says so.
- **Your data is yours alone.** Everyone registered with the same bot has
  completely separate expenses, budgets and holdings. Your Gemini key is
  stored encrypted and only used for your own messages.
- **Plutus never guesses.** If it can't understand a message, it says so
  rather than logging something wrong. The same goes for statements it can't
  read and holdings it can't price.
- **The Gemini free tier is rate-limited.** If replies start failing after
  heavy use, it's usually the daily limit; they resume the next day.
- **Statements must be sent as a file, not a photo.** Photos are reserved for
  `/split` receipts.

---

## For developers

Plutus is TypeScript on Node 22: a [grammy](https://grammy.dev) Telegram bot
and a [Hono](https://hono.dev) app, with Drizzle ORM over libSQL (a SQLite
file locally, [Turso](https://turso.tech) in production). Every message is
understood by the user's own Gemini key, with no rule-based fallback. It runs
on Vercel for free, or as one long-running process locally.

```bash
npm install
npm run dev        # run locally against a SQLite file, with a development bot
npm test           # the full test suite, no network needed
npm run typecheck
npm run lint
```

- [SETUP.md](SETUP.md) — deploy your own, and local development
- [docs/architecture.md](docs/architecture.md) — diagrams and design decisions
- [CLAUDE.md](CLAUDE.md) — detailed notes on how the code fits together
- [docs/tasks/](docs/tasks/) — the plan the modules were built against

## License

ISC
