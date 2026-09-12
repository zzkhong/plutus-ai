import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// DATABASE_URL must be set before anything pulls in src/config or src/db.
// TypeScript hoists every `require` above this line, so ./statement-parser
// (which reaches src/db through users/service) is loaded dynamically in the
// before hook instead of imported statically.
process.env.DATABASE_URL = './data/test-statement-parser.db';

const testDbPath = path.resolve('./data/test-statement-parser.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

type ParserModule = typeof import('./statement-parser');
let parser: ParserModule;
let userId: string;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  await runMigrations();
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const user = await createUser('test-statement-parser-chat');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-tests'), true);
  userId = user.id;
  parser = await import('./statement-parser');
});

const NOW = new Date('2026-09-12T10:00:00');

/**
 * What the model returns for the real Interactive Brokers activity statement
 * dated 10 Sep 2026 (account U6602063): the ten positions from its Open
 * Positions table, with close price and value exactly as printed.
 */
const IBKR_STATEMENT_RESPONSE = JSON.stringify({
  broker: 'ibkr',
  statement_date: '2026-09-10',
  holdings: [
    { symbol: 'AAPL', name: 'APPLE INC', quantity: 38.3108, price: 326.57, market_value: 12511.16, currency: 'USD', asset_class: 'stocks_us', market: 'NASDAQ' },
    { symbol: 'GLD', name: 'SPDR GOLD SHARES', quantity: 0.2432, price: 396.36, market_value: 96.39, currency: 'USD', asset_class: 'stocks_us', market: 'ARCA' },
    { symbol: 'INTC', name: 'INTEL CORP', quantity: 9.5384, price: 100.32, market_value: 956.89, currency: 'USD', asset_class: 'stocks_us', market: 'NASDAQ' },
    { symbol: 'MSFT', name: 'MICROSOFT CORP', quantity: 4.737, price: 492.44, market_value: 2332.69, currency: 'USD', asset_class: 'stocks_us', market: 'NASDAQ' },
    { symbol: 'NVDA', name: 'NVIDIA CORP', quantity: 106.3419, price: 218.36, market_value: 23220.82, currency: 'USD', asset_class: 'stocks_us', market: 'NASDAQ' },
    { symbol: 'QQQ', name: 'INVESCO QQQ TRUST SERIES 1', quantity: 0.6994, price: 708.69, market_value: 495.66, currency: 'USD', asset_class: 'stocks_us', market: 'NASDAQ' },
    { symbol: 'SMH', name: 'VANECK SEMICONDUCTOR ETF', quantity: 0.1835, price: 560.28, market_value: 102.81, currency: 'USD', asset_class: 'stocks_us', market: 'NASDAQ' },
    { symbol: 'TSLA', name: 'TESLA INC', quantity: 17.1718, price: 363.56, market_value: 6242.98, currency: 'USD', asset_class: 'stocks_us', market: 'NASDAQ' },
    { symbol: 'VOO', name: 'VANGUARD S&P 500 ETF', quantity: 20.8428, price: 696.65, market_value: 14520.14, currency: 'USD', asset_class: 'stocks_us', market: 'ARCA' },
    { symbol: 'VTI', name: 'VANGUARD TOTAL STOCK MKT ETF', quantity: 0.8969, price: 373.24, market_value: 334.76, currency: 'USD', asset_class: 'stocks_us', market: 'ARCA' },
  ],
});

function position(overrides: Record<string, unknown> = {}) {
  return { symbol: 'AAPL', name: 'Apple', quantity: 10, price: 300, currency: 'USD', asset_class: 'stocks_us', market: 'NASDAQ', ...overrides };
}

function response(holdings: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ broker: 'ibkr', statement_date: '2026-09-10', holdings, ...extra });
}

test('reads the IBKR statement: broker, statement date and all ten positions', () => {
  const statement = parser.parseStatementResponse(IBKR_STATEMENT_RESPONSE, NOW);

  assert.equal(statement.broker, 'ibkr');
  assert.equal(statement.as_of.getTime(), new Date('2026-09-10T00:00:00').getTime());
  assert.equal(statement.holdings.length, 10);
  assert.deepEqual(statement.skipped, []);

  const aapl = statement.holdings.find((h) => h.symbol === 'AAPL');
  assert.equal(aapl?.quantity, 38.3108);
  assert.equal(aapl?.price, 326.57);
  assert.equal(aapl?.currency, 'USD');
});

test("the IBKR statement's prices reproduce its own stock total of US$60,814.30", () => {
  const statement = parser.parseStatementResponse(IBKR_STATEMENT_RESPONSE, NOW);
  const total = statement.holdings.reduce((sum, h) => sum + h.quantity * (h.price ?? 0), 0);

  assert.ok(Math.abs(total - 60814.3) < 0.05, `positions add up to ${total.toFixed(2)}`);
});

test('works out the unit price from the market value when a statement shows only totals', () => {
  const statement = parser.parseStatementResponse(response([position({ price: null, market_value: 3265.7 })]), NOW);
  assert.equal(statement.holdings[0].price, 326.57);
});

test('accepts numbers written with thousands separators', () => {
  const statement = parser.parseStatementResponse(
    response([position({ quantity: '1,000', price: '12,511.16' })]),
    NOW,
  );
  assert.equal(statement.holdings[0].quantity, 1000);
  assert.equal(statement.holdings[0].price, 12511.16);
});

test('normalizes the broker name so a newer statement replaces the older one', () => {
  assert.equal(parser.normalizeBroker('ibkr'), 'ibkr');
  assert.equal(parser.normalizeBroker('Interactive Brokers'), 'ibkr');
  assert.equal(parser.normalizeBroker('Interactive Brokers LLC'), 'ibkr');
  assert.equal(parser.normalizeBroker('Moomoo'), 'moomoo');
  assert.equal(parser.normalizeBroker('Futu'), 'moomoo');
  assert.equal(parser.normalizeBroker('Tiger Brokers'), 'tiger');
  assert.equal(parser.normalizeBroker('Saxo Bank'), 'saxobank');
});

test('skips positions it cannot value and says why, instead of failing the whole import', () => {
  const statement = parser.parseStatementResponse(
    response([
      position(),
      position({ symbol: '0700', currency: 'HKD' }),
      position({ symbol: 'SGS', asset_class: 'other' }),
      position({ symbol: 'NOPX', price: null, market_value: null }),
    ]),
    NOW,
  );

  assert.deepEqual(statement.holdings.map((h) => h.symbol), ['AAPL']);
  assert.deepEqual(statement.skipped, [
    { symbol: '0700', reason: 'priced in HKD' },
    { symbol: 'SGS', reason: 'not a US, SGX or Bursa listing' },
    { symbol: 'NOPX', reason: 'no price on the statement' },
  ]);
});

test('fails when none of the positions can be valued', () => {
  assert.throws(
    () => parser.parseStatementResponse(response([position({ currency: 'HKD' })]), NOW),
    /none of its positions can be valued/,
  );
});

test('fails for a file that is not a statement', () => {
  assert.throws(
    () => parser.parseStatementResponse('{"broker": null, "statement_date": null, "holdings": []}', NOW),
    parser.StatementParseError,
  );
});

test('fails on text that is not JSON, or broken JSON', () => {
  assert.throws(() => parser.parseStatementResponse('not json at all', NOW), parser.StatementParseError);
  assert.throws(() => parser.parseStatementResponse('{ broken json', NOW), parser.StatementParseError);
});

test('fails on a missing, zero or negative quantity', () => {
  for (const quantity of [0, -5, 'ten', null]) {
    assert.throws(
      () => parser.parseStatementResponse(response([position({ quantity })]), NOW),
      parser.StatementParseError,
      `quantity ${String(quantity)}`,
    );
  }
});

test('dates the prices at upload time when the statement date is missing, malformed or in the future', () => {
  for (const statementDate of [null, '10/09/2026', '2027-01-01']) {
    const statement = parser.parseStatementResponse(response([position()], { statement_date: statementDate }), NOW);
    assert.equal(statement.as_of.getTime(), NOW.getTime(), `statement_date ${String(statementDate)}`);
  }
});

function geminiResponse(text: string): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('sends a PDF or screenshot to the model as file data, and a CSV as text', async () => {
  const originalFetch = global.fetch;
  const bodies: string[] = [];
  global.fetch = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(init?.body ?? '');
    return geminiResponse(IBKR_STATEMENT_RESPONSE);
  }) as unknown as typeof fetch;

  try {
    await parser.parseStatement(userId, { data: Buffer.from('%PDF-1.4 fake'), kind: 'pdf', mimeType: 'application/pdf' });
    await parser.parseStatement(userId, { data: Buffer.from('fake png'), kind: 'image', mimeType: 'image/png' });
    const csv = await parser.parseStatement(userId, {
      data: Buffer.from('Symbol,Quantity,Close Price\nAAPL,38.3108,326.57\n'),
      kind: 'text',
      mimeType: 'text/csv',
    });

    assert.match(bodies[0], /"mimeType":"application\/pdf"/);
    assert.match(bodies[1], /"mimeType":"image\/png"/);
    assert.doesNotMatch(bodies[2], /inlineData/);
    assert.match(bodies[2], /AAPL,38\.3108,326\.57/);
    assert.equal(csv.holdings.length, 10);
  } finally {
    global.fetch = originalFetch;
  }
});

test('surfaces a model or network failure as StatementParseError, not a raw error', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => parser.parseStatement(userId, { data: Buffer.from('%PDF-1.4 fake'), kind: 'pdf', mimeType: 'application/pdf' }),
      parser.StatementParseError,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

/**
 * Opt-in: reads a real statement file with the real model.
 *
 *   RUN_LIVE_AI_TESTS=1 GOOGLE_API_KEY=... STATEMENT_FILE=path/to/statement.pdf \
 *     npx tsx --test src/portfolio/statement-parser.test.ts
 */
test(
  'reads a real statement file with the live model',
  {
    skip:
      !(process.env.RUN_LIVE_AI_TESTS && process.env.STATEMENT_FILE && process.env.GOOGLE_API_KEY) &&
      'set RUN_LIVE_AI_TESTS=1, GOOGLE_API_KEY and STATEMENT_FILE to run this against a real statement',
  },
  async () => {
    const { setProvider, completeSetup } = await import('../users/service');
    const { encrypt } = await import('../users/crypto');
    await setProvider(userId, 'gemini');
    await completeSetup(userId, encrypt(process.env.GOOGLE_API_KEY!), true);

    const filePath = process.env.STATEMENT_FILE!;
    const extension = path.extname(filePath).toLowerCase();
    const kind = extension === '.pdf' ? 'pdf' : ['.png', '.jpg', '.jpeg', '.webp'].includes(extension) ? 'image' : 'text';
    const mimeType =
      kind === 'pdf' ? 'application/pdf' : kind === 'image' ? `image/${extension === '.jpg' ? 'jpeg' : extension.slice(1)}` : 'text/csv';

    const statement = await parser.parseStatement(userId, { data: fs.readFileSync(filePath), kind, mimeType });

    console.log(`broker=${statement.broker} as_of=${statement.as_of.toDateString()}`);
    for (const h of statement.holdings) {
      console.log(`  ${h.symbol.padEnd(8)} ${String(h.quantity).padStart(10)} x ${h.price} ${h.currency}`);
    }
    if (statement.skipped.length > 0) {
      console.log('  skipped:', statement.skipped);
    }
    assert.ok(statement.holdings.length > 0);
  },
);
