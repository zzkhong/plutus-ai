# Plutus AI - Personal Finance AI Assistant

A comprehensive personal finance management system powered by AI, built with Node.js, TypeScript, and Telegram integration.

## Project Overview

Plutus AI is a modular financial assistant that helps you:
- Track expenses across multiple currencies and payment methods
- Manage budgets and spending limits
- Monitor investment portfolio performance
- Schedule and track recurring transactions
- Receive intelligent financial insights via Telegram daily digest
- Integrate with iOS Shortcuts for quick expense logging

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js + TypeScript |
| **Database** | SQLite (better-sqlite3) |
| **ORM** | Drizzle ORM |
| **AI Model** | Google Gemini Flash (free tier) |
| **Bot Framework** | Grammy (Telegram) |
| **Task Scheduler** | node-cron |
| **HTTP Server** | Hono |
| **Validation** | Zod |
| **Dev Tools** | ts-node, ESLint, Prettier |

## Project Structure

```
plutus-ai/
├── src/
│   ├── index.ts                  # Application entry point
│   ├── config/
│   │   ├── env.ts                # Environment variable validation
│   │   ├── currencies.ts         # Currency definitions and conversion
│   │   └── index.ts
│   ├── types/
│   │   ├── transaction.ts        # Transaction and expense types
│   │   ├── portfolio.ts          # Investment portfolio types
│   │   ├── budget.ts             # Budget and spending types
│   │   └── index.ts
│   ├── db/
│   │   ├── schema.ts             # Database schema (Drizzle)
│   │   ├── client.ts             # Database connection and initialization
│   │   └── index.ts
│   └── utils/
│       ├── currency.ts           # Currency conversion utilities
│       ├── logger.ts             # Logging utility
│       └── index.ts
├── data/                          # SQLite database directory
├── package.json
├── tsconfig.json
├── .eslintrc.js
├── .prettierrc
├── .env.example
└── README.md
```

## Prerequisites

- Node.js 18+ and npm
- Google API key (for Gemini AI - free tier available)
- Telegram Bot Token (from BotFather)

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/zzkhong/plutus-ai.git
cd plutus-ai
```

### 2. Install dependencies

```bash
npm install
```

### 3. Setup environment variables

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
NODE_ENV=development
TZ=Asia/Singapore
DATABASE_URL=./data/pluto.db
TELEGRAM_BOT_TOKEN=your_token_here
GOOGLE_API_KEY=your_api_key_here
LOG_LEVEL=info
PORT=3000
```

`TZ` must be set to `Asia/Singapore` so the process computes "today" boundaries (used by expense summaries and the daily digest) in the same timezone as the digest's 10pm SGT cron schedule.

## Usage

### Development

Start the application in development mode (with hot reload via ts-node):

```bash
npm run dev
```

### Build

Compile TypeScript to JavaScript:

```bash
npm run build
```

### Production

Run the compiled application:

```bash
npm run start
```

### Linting and Formatting

Check for linting issues:

```bash
npm run lint
```

Auto-format code:

```bash
npm run format
```

## Database

### Schema Overview

The application uses SQLite with the following core tables:

#### `transactions`
- Stores all expense and income transactions
- Supports multiple currencies with automatic SGD normalization
- Fields: id, amount, currency, amount_sgd, merchant, category, source, card_name, note, created_at, updated_at

#### `holdings`
- Portfolio investment tracking (stocks, crypto, etc.)
- Fields: id, symbol, name, asset_class, quantity, currency, market, cost_basis, created_at, updated_at

#### `budgets`
- Budget limits by category and time period
- Fields: id, category, amount, currency, amount_sgd, period, created_at, updated_at

#### `recurring_transactions`
- Recurring expenses and income
- Fields: id, amount, currency, merchant, category, day_of_month, is_active, created_at, updated_at

#### `user_config`
- Key-value store for user preferences
- Fields: key, value

### Database Location

The SQLite database file is stored at `./data/pluto.db` (created automatically on first run).

## Supported Currencies

- SGD (Singapore Dollar) - Base currency
- MYR (Malaysian Ringgit)
- USD (US Dollar)
- BTC (Bitcoin)
- ETH (Ethereum)
- BETH (Beacon Ethereum)

All amounts are normalized to SGD for reporting and analysis.

## API and Types

### Core Types

All TypeScript types are defined in `src/types/` and exported from `src/types/index.ts`:

```typescript
// Transaction
export type Currency = 'SGD' | 'MYR' | 'USD' | 'BTC' | 'ETH' | 'BETH'
export type Category = 'Food' | 'Transport' | 'Shopping' | ...
export interface Transaction { ... }
export interface RecurringTransaction { ... }

// Portfolio
export type AssetClass = 'stocks_us' | 'stocks_my' | 'crypto' | 'cash'
export interface Holding { ... }
export interface Portfolio { ... }

// Budget
export type BudgetPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly'
export interface Budget { ... }
export interface BudgetSummary { ... }
```

### Database Access

Access the database through the singleton instance:

```typescript
import { db } from './db'

// Query example
const transactions = await db.query.transactions.findMany()
```

### Configuration

Configuration values are validated at startup:

```typescript
import { config } from './config'

console.log(config.NODE_ENV)      // 'development' | 'production' | 'test'
console.log(config.DATABASE_URL)  // './data/pluto.db'
```

### Currency Utilities

```typescript
import { currencyUtils } from './utils'

currencyUtils.convert(10000, 'SGD', 'USD')  // Convert amount
currencyUtils.toSGD(10000, 'USD')           // Convert to base currency
currencyUtils.format(10000, 'SGD')          // Format for display: S$100.00
```

### Logger

```typescript
import { logger } from './utils'

logger.info('Message', { key: 'value' })
logger.warn('Warning', { data: 'here' })
logger.error('Error', error)
logger.debug('Debug info')  // Only shown in debug mode
```

## Module Dependencies

This foundation module provides the base layer for all other modules:

| Module | Dependencies |
|--------|--------------|
| **02-telegram-bot** | Project Foundation (types, config, db, logger) |
| **03-expense-engine** | Project Foundation |
| **04-portfolio-tracker** | Project Foundation |
| **05-budget-system** | Project Foundation |
| **06-daily-digest** | All modules above + AI integration |
| **07-ios-shortcut-integration** | Project Foundation |

## Development Guidelines

### Code Style

- Use TypeScript strict mode
- Follow ESLint and Prettier formatting
- Use consistent naming conventions (camelCase for variables/functions, PascalCase for types/classes)

### Adding New Features

1. Define types in `src/types/`
2. Create configuration in `src/config/` if needed
3. Add database schema in `src/db/schema.ts`
4. Implement logic in feature-specific modules
5. Export public interfaces from `src/types/index.ts` and `src/db/index.ts`

### Currency Handling

- Always store amounts in **cents** (not decimal) to avoid floating-point issues
- Store `amount_sgd` for all multi-currency transactions
- Use currency utilities from `src/config/currencies.ts` for conversions
- Exchange rates should be updated periodically (currently hardcoded)

## Configuration Details

### Environment Validation

The `env.ts` file validates all required environment variables using Zod schema. Missing or invalid variables will cause startup to fail with descriptive error messages.

### Card Mapping

Define which payment cards/accounts use which currency in `src/config/currencies.ts`:

```typescript
export const DEFAULT_CARD_CURRENCY_MAP = {
  'OCBC iPhone': 'SGD',
  'Crypto.com': 'USD',
  'Binance': 'USD',
}
```

## Troubleshooting

### Database Connection Issues

If you see database errors:
1. Ensure `./data/` directory exists and is writable
2. Check `DATABASE_URL` in `.env`
3. Try deleting `./data/pluto.db` to reset (will lose all data)

### TypeScript Compilation Errors

```bash
npm run build
```

Check the output for type errors. Fix them before attempting to deploy.

### Module Import Errors

Ensure you're importing from the correct paths:
- Types: `import { ... } from './types'`
- Config: `import { ... } from './config'`
- Database: `import { db } from './db'`
- Utils: `import { logger, currencyUtils } from './utils'`

## Next Steps

After foundation setup is complete, proceed to:

1. **PLUTO-02: Telegram Bot** - Set up Telegram bot for expense logging
2. **PLUTO-03: Expense Engine** - Implement expense tracking and categorization
3. **PLUTO-04: Portfolio Tracker** - Add investment portfolio tracking
4. **PLUTO-05: Budget System** - Implement budget management
5. **PLUTO-06: Daily Digest** - Set up scheduled AI-powered financial summaries
6. **PLUTO-07: iOS Shortcut Integration** - Add quick logging via iOS Shortcuts

## License

ISC License - See LICENSE file for details

## Contributing

Contributions are welcome! Please ensure:
- Code follows ESLint rules
- Types are properly defined
- All changes are tested locally with `npm run dev`
- Database schema changes are documented

## Support

For issues or questions:
1. Check troubleshooting section
2. Review code comments and type definitions
3. Check database schema in `src/db/schema.ts`
4. Open an issue on GitHub

---

**Status**: Foundation layer complete ✓
**Ready for**: Module-specific development (PLUTO-02 onwards)
