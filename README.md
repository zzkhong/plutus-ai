# Plutus AI

**A personal finance assistant that lives in Telegram.** Tell it what you
spent, the way you'd text a friend, and it keeps your expenses and budgets in
order. No app to open, no forms to fill in.

```
You:     Spent $4.50 at Ya Kun
Plutus:  Logged S$4.50 at Ya Kun under Food.
         [ Change category ] [ Undo ]

You:     Grab 18 yesterday
Plutus:  Logged S$18.00 at Grab under Transport, on 11 Sep 2026.

         ⚠️ Transport budget alert: you've used 80% (S$161.00 / S$200.00) this month.
         [ Change category ] [ Undo ]

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
- **Say when, if it wasn't today.** *"Grab 18 yesterday"* or *"dinner $60 last
  Friday"* is logged on that day, so it counts toward the right day and month.
- **Or send a voice note.** Plutus transcribes it and handles it exactly like
  a typed message. Its reply starts with `Heard: "…"`, so you can see what it
  understood.
- **Or snap the receipt.** Send a photo of any receipt and Plutus logs its
  total, merchant and date in one go. (To split the bill instead, send
  `/split` first.)
- **Categories are automatic, and they learn from you.** Every expense lands
  in one of Food, Transport, Groceries, Entertainment, Bills, Health,
  Education, Travel, Shopping or Others. Once you've logged a merchant, the
  next expense there goes to the same category, including any change you
  made to it.
- **Three currencies.** Spend in SGD, MYR or USD. Everything is also stored in
  SGD at that day's exchange rate, so your totals and budgets always add up,
  and the reply shows both: *"Logged RM45.00 (S$14.02) at Kopitiam under
  Food."*
- **One tap to fix it.** Every expense Plutus logs comes with **Change
  category** and **Undo** buttons. To change the amount, merchant or date,
  reply to that message: *"it was $12"*, *"that was yesterday"*. Or just say
  it next, *"actually that was $12"* or *"it was in ringgit"*, and it fixes
  your latest expense.
- **Fix anything recent.** `/recent` lists your last 10 expenses. Tap one to
  change its category or delete it, or reply to it to fix the rest.
- **Recurring charges log themselves.** *"Netflix $15.98 every 5th"* logs that
  charge on the 5th of every month (one added on its due day is logged
  straight away). A charge on the 31st is logged on the last day of shorter
  months. Say it again with a new price or day to change it; *"Cancel my
  Netflix"* stops it. `/recurring`, or *"show my subscriptions"*, lists them
  all with what they cost a month and a Remove button each.
- **Apple Pay, automatically** (optional). With an iOS Shortcut, every Apple
  Pay purchase is logged the moment you tap your phone, with the same buttons
  on its confirmation. See [the Shortcut guide](docs/setup/ios-shortcut-setup.md).

### Know your savings rate

Tell Plutus when money comes in: *"Salary $5200 came in"*, *"freelance RM
800"*. Income is kept apart from spending, and `/month` adds what you kept:

```
This month's spend: S$2345.60 across 87 transactions.
  Food: S$812.30 (41)
  …

Income: S$5200.00 · saved S$2854.40 (54.9%).
```

### Stay on budget

- **Set a monthly budget per category**, in any of the three currencies:
  *"Set food budget to $500"*, *"Transport budget RM 300"*. Say it again to
  change the amount; *"remove my food budget"* deletes it.
- **Or one budget for everything.** *"Monthly budget $3000"* sets an overall
  budget across all your spending, alongside any category budgets.
- **Alerts when it matters.** When an expense takes a budget past **80%**, and
  again past **100%**, the alert comes with that expense's reply.
- **And a warning before that, if the pace is off.** From the 7th of the
  month, if your spending so far points well past a budget by month end,
  Plutus says so once: *"📈 Food budget: at this pace you'll spend about
  S$618.00 of your S$500.00 this month (S$206.00 so far, 20 days left)."*
  Each alert fires once a month, and budgets start fresh on the 1st.
- **Check in any time.** `/budget` shows every budget at a glance, and where
  it's heading:

  ```
  Budgets this month (18 days left):
  Overall: S$1204.50 of S$3000.00 (40.2%), S$1795.50 left
  Food: S$212.40 of S$500.00 (42.5%), S$287.60 left, on pace for S$531.00
  Transport: S$214.00 of S$200.00 (107%), over by S$14.00
  ```

- **Ask about your spending.** *"How much did I spend today?"*, *"…in the last
  week?"*, *"…on transport this month?"* — or use `/today` and `/month` for a
  breakdown by category.

### A month in review

On the 1st, Plutus sends you last month in numbers. `/review` shows it any
time:

```
📅 August 2026 in review

Spent S$2345.60 across 87 expenses, 12% less than July (S$2665.20).
Income: S$5200.00 · saved S$2854.40 (54.9%).

Where it went:
  Food: S$812.30 (↑8%)
  Transport: S$410.00 (↓15%)
  Bills: S$380.00 (new)

Top merchants:
  FairPrice: S$320.40 (9 times)
  Grab: S$290.00 (21 times)
  Kopitiam: S$188.50 (30 times)

Budgets: kept 2 of 3.
  ✅ Overall: S$2345.60 of S$3000.00
  ✅ Food: S$812.30 of S$900.00
  ❌ Transport: S$410.00 of S$350.00, over by S$60.00
```

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
  5000"*). For a coin Plutus doesn't know, it shows the coins with that
  ticker on CoinGecko and you tap yours. `/portfolio` shows your net worth
  and where it sits.
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
| `/month` | This month's spending by category, and your savings rate |
| `/budget` | How every budget is doing this month, and where it's heading |
| `/recent` | Your last 10 expenses, to change or delete any of them |
| `/recurring` | Your recurring charges and their monthly total, to remove any of them |
| `/undo` | Remove your most recent expense |
| `/review` | Last month in review |
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
| "Grab 18 yesterday" · "dinner $60 last Friday" | logs it on that day |
| a photo of a receipt | logs its total, merchant and date |
| "Actually that was $12" · "it was in ringgit" · "that was Transport" | corrects your latest expense |
| a reply to an expense: "it was $12" · "that was yesterday" | corrects that expense |
| "Salary $5200 came in" · "freelance RM 800" | records income |
| "How much did I spend this week?" · "…on food this month?" | tells you, with the budget if you have one |
| "Set food budget to $500" · "Monthly budget $3000" · "Remove my travel budget" | sets or removes a budget |
| "Netflix $15.98 every 5th" · "Netflix is now $17.98" · "Cancel my Spotify" | starts, changes or stops a recurring charge |
| "Show my recurring expenses" · "What subscriptions do I have?" | lists them, same as `/recurring` |
| "I hold 0.5 BTC" · "cash SGD 5000" | adds a crypto or cash holding |
| a voice note saying any of the above | does the same |

---

## Good to know

- **A typed correction fixes your latest expense**, unless you send it as a
  reply to a particular one. `/undo` always removes the latest. For anything
  older, use its buttons or `/recent`.
- **"This week" means the last 7 days**, and the answer says so.
- **Photos are receipts.** A photo is logged as an expense unless a `/split`
  is waiting for it. Brokerage statements must be sent as a file.
- **Your data is yours alone.** Everyone registered with the same bot has
  completely separate expenses, income, budgets and holdings. Your Gemini key
  is stored encrypted and only used for your own messages.
- **Plutus never guesses.** If it can't understand a message, it says so
  rather than logging something wrong. The same goes for receipts and
  statements it can't read, and holdings it can't price.
- **The Gemini free tier is rate-limited.** Plutus makes one Gemini call per
  message, and none to categorize a merchant it has seen before. If replies
  start failing after heavy use, it's usually the daily limit; they resume
  the next day.

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

## License

ISC
