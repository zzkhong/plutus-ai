import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Must precede anything that reaches src/config or src/db — see CLAUDE.md.
process.env.DATABASE_URL = './data/test-portfolio-advice.db';

const testDbPath = path.resolve('./data/test-portfolio-advice.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

type AdviceModule = typeof import('./advice');
let generatePortfolioAdvice: AdviceModule['generatePortfolioAdvice'];
let buildAdvicePrompt: AdviceModule['buildAdvicePrompt'];
let NO_HOLDINGS_MESSAGE: AdviceModule['NO_HOLDINGS_MESSAGE'];
let UNGROUNDED_CAVEAT: AdviceModule['UNGROUNDED_CAVEAT'];

let userId: string;
let otherUserId: string;
const originalFetch = global.fetch;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  await runMigrations();
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');

  const user = await createUser('test-advice-chat');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-tests'), true);
  userId = user.id;

  const other = await createUser('test-advice-other-chat');
  await setProvider(other.id, 'gemini');
  await completeSetup(other.id, encrypt('fake-key-for-tests'), true);
  otherUserId = other.id;

  const advice = await import('./advice');
  generatePortfolioAdvice = advice.generatePortfolioAdvice;
  buildAdvicePrompt = advice.buildAdvicePrompt;
  NO_HOLDINGS_MESSAGE = advice.NO_HOLDINGS_MESSAGE;
  UNGROUNDED_CAVEAT = advice.UNGROUNDED_CAVEAT;
});

after(() => {
  global.fetch = originalFetch;
});

function geminiResponse(text: string): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Captures every request body so a test can assert what was actually sent,
 * and optionally rejects grounded calls to exercise the fallback path.
 */
function stubProvider(options: { text: string; failGrounded?: boolean }) {
  const bodies: string[] = [];
  global.fetch = (async (_input: unknown, init?: { body?: string }) => {
    const body = init?.body ?? '';
    bodies.push(body);
    if (options.failGrounded && body.includes('googleSearchRetrieval')) {
      throw new Error('grounding tool not supported by this model');
    }
    return geminiResponse(options.text);
  }) as unknown as typeof fetch;
  return bodies;
}

function holding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'h1',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    asset_class: 'stocks_us',
    quantity: 10,
    currency: 'USD',
    market: 'NASDAQ',
    broker: 'ibkr',
    created_at: new Date(),
    updated_at: new Date(),
    quote: { price: 190.5, currency: 'USD', change_pct: 2.34, as_of: new Date() },
    value_sgd: 256000,
    ...overrides,
  };
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    net_worth_sgd: 256000,
    by_class: [{ key: 'stocks_us', value_sgd: 256000, pct: 100 }],
    by_currency: [{ key: 'USD', value_sgd: 256000, pct: 100 }],
    holdings: [holding()],
    ...overrides,
  } as any;
}

test('buildAdvicePrompt feeds the already-computed values and tells the model not to invent numbers', () => {
  const prompt = buildAdvicePrompt(summary());

  assert.match(prompt, /Net worth: S\$2560\.00/);
  assert.match(prompt, /AAPL/);
  assert.match(prompt, /10 units/);
  assert.match(prompt, /S\$2560\.00/);
  assert.match(prompt, /\+2\.34% today/);
  assert.match(prompt, /do not invent/i);
});

test('buildAdvicePrompt marks an unpriced holding as price unavailable instead of dropping it', () => {
  const prompt = buildAdvicePrompt(summary({ holdings: [holding({ quote: null, symbol: 'XYZ' })] }));

  assert.match(prompt, /XYZ/);
  assert.match(prompt, /price unavailable/);
});

test('buildAdvicePrompt renders a negative change with its sign', () => {
  const prompt = buildAdvicePrompt(
    summary({ holdings: [holding({ quote: { price: 1, currency: 'USD', change_pct: -3.5, as_of: new Date() } })] }),
  );

  assert.match(prompt, /-3\.50% today/);
});

test('generatePortfolioAdvice returns the friendly empty state without calling the provider', async () => {
  let called = false;
  global.fetch = (async () => {
    called = true;
    return geminiResponse('should not be reached');
  }) as unknown as typeof fetch;

  const result = await generatePortfolioAdvice(userId, summary({ holdings: [], net_worth_sgd: 0, by_class: [] }));

  assert.equal(result, NO_HOLDINGS_MESSAGE);
  assert.equal(called, false, 'empty portfolio should not spend an LLM call');
});

test('generatePortfolioAdvice returns grounded advice with no caveat', async () => {
  stubProvider({ text: 'Markets were flat. Hold.' });

  const result = await generatePortfolioAdvice(userId, summary());

  assert.equal(result, 'Markets were flat. Hold.');
  assert.doesNotMatch(result, /general knowledge/);
});

test('generatePortfolioAdvice asks for search grounding on the first attempt', async () => {
  const bodies = stubProvider({ text: 'Advice.' });

  await generatePortfolioAdvice(userId, summary());

  assert.ok(bodies.length > 0);
  assert.match(bodies[0], /googleSearchRetrieval/, 'first attempt should request grounding');
});

test('generatePortfolioAdvice falls back with a caveat when grounding is unsupported', async () => {
  const bodies = stubProvider({ text: 'Markets were flat. Hold.', failGrounded: true });

  const result = await generatePortfolioAdvice(userId, summary());

  assert.match(result, /Markets were flat\. Hold\./);
  assert.match(result, new RegExp(UNGROUNDED_CAVEAT.replace(/[.()]/g, '\\$&')));
  assert.equal(bodies.length, 2, 'should retry once without the grounding tool');
  assert.doesNotMatch(bodies[1], /googleSearchRetrieval/);
});

test('generatePortfolioAdvice throws when the provider fails outright, so settle can degrade the section', async () => {
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as unknown as typeof fetch;

  await assert.rejects(() => generatePortfolioAdvice(userId, summary()));
});

test('generatePortfolioAdvice throws on empty provider output rather than sending a blank section', async () => {
  stubProvider({ text: '   ' });

  await assert.rejects(() => generatePortfolioAdvice(userId, summary()), /empty/i);
});

test('generatePortfolioAdvice builds the prompt only from the summary it is handed', async () => {
  const bodies = stubProvider({ text: 'Advice.' });

  // Same call, two different users: the prompt must reflect the passed-in
  // summary, never anything read back for the other user.
  await generatePortfolioAdvice(userId, summary({ holdings: [holding({ symbol: 'AAAA' })] }));
  await generatePortfolioAdvice(otherUserId, summary({ holdings: [holding({ symbol: 'BBBB' })] }));

  assert.match(bodies[0], /AAAA/);
  assert.doesNotMatch(bodies[0], /BBBB/);
  assert.match(bodies[bodies.length - 1], /BBBB/);
  assert.doesNotMatch(bodies[bodies.length - 1], /AAAA/);
});

test('buildAdvicePrompt gives a statement-priced holding its statement date instead of a daily move', () => {
  const prompt = buildAdvicePrompt(
    summary({
      holdings: [
        holding({
          quote: { price: 326.57, currency: 'USD', change_pct: null, as_of: new Date('2026-09-10T00:00:00'), source: 'statement' },
        }),
      ],
    }),
  );

  assert.match(prompt, /statement price/);
  assert.doesNotMatch(prompt, /% today/);
});
