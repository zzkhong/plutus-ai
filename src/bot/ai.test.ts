import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-ai-budget.db';

const aiTestDbPath = path.resolve('./data/test-ai-budget.db');
if (fs.existsSync(aiTestDbPath)) {
  fs.rmSync(aiTestDbPath, { force: true });
}

let userId: string;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  await runMigrations();
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const user = await createUser('test-ai-chat');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-stubbed-tests'), true); // isAdmin so it lands on 'approved' immediately
  userId = user.id;
});

test(
  'classifyUserMessage returns expense intent for a real Gemini call',
  { skip: !process.env.RUN_LIVE_AI_TESTS && 'set RUN_LIVE_AI_TESTS=1 to run this against the real Gemini API' },
  async () => {
    const { classifyUserMessage } = await import('./ai');
    const { setProvider, completeSetup } = await import('../users/service');
    const { encrypt } = await import('../users/crypto');

    // Read straight off the environment: GOOGLE_API_KEY is no longer part of
    // the validated app config (every user brings their own key), it is just
    // a convenient place to park a real key for this opt-in live test.
    const liveKey = process.env.GOOGLE_API_KEY;
    assert.ok(liveKey, 'set GOOGLE_API_KEY in the environment to run this live test');

    await setProvider(userId, 'gemini');
    await completeSetup(userId, encrypt(liveKey), true);

    const result = await classifyUserMessage(userId, 'Spent $4.50 at Ya Kun');
    assert.equal(result.intent, 'expense');
    assert.equal(result.serviceError, undefined);
  },
);

test('classifyUserMessage degrades gracefully instead of guessing when the Gemini call fails', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { classifyUserMessage } = await import('./ai');
    const result = await classifyUserMessage(userId, 'Spent $4.50 at Ya Kun');
    assert.equal(result.intent, 'unknown');
    assert.equal(result.serviceError, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('buildAssistantReply logs a real expense transaction for the expense intent', async () => {
  const { stubGeminiCategorization } = await import('../testing/geminiStub');
  const restoreGemini = stubGeminiCategorization();

  try {
    const { buildAssistantReply } = await import('./ai');
    const reply = await buildAssistantReply(userId, {
      intent: 'expense',
      confidence: 0.96,
      extracted: {
        amount: 4.5,
        merchant: 'Ya Kun',
        category: 'Food',
      },
      rawText: 'Spent $4.50 at Ya Kun',
    });

    assert.match(reply, /4\.50/i);
    assert.match(reply, /Ya Kun/i);

    const { getTopExpenses } = await import('../expense/service');
    const [logged] = await getTopExpenses(userId, 'today', 1);
    assert.ok(logged);
    assert.equal(logged.merchant, 'Ya Kun');
    assert.equal(logged.amount, 450);
    assert.equal(logged.source, 'text');
  } finally {
    restoreGemini();
  }
});

test('buildAssistantReply asks for an amount when the expense intent has none', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'expense',
    confidence: 0.4,
    extracted: { merchant: 'Ya Kun' },
    rawText: 'bought something at Ya Kun',
  });

  assert.match(reply, /how much/i);
});

test('buildAssistantReply returns the generic error message when Gemini failed, not a guessed intent', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'unknown',
    confidence: 0,
    extracted: {},
    rawText: 'Spent $4.50 at Ya Kun',
    serviceError: true,
  });

  assert.match(reply, /hiccupped/i);
});

test('buildAssistantReply sets a real budget for the budget intent', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'budget',
    confidence: 0.9,
    extracted: { category: 'Food', budgetAmount: 800 },
    rawText: 'Set food budget to $800/month',
  });

  assert.match(reply, /Food/);
  assert.match(reply, /800\.00/);

  const { findBudgetByCategory } = await import('../budget/service');
  const budget = await findBudgetByCategory(userId, 'Food');
  assert.ok(budget);
  assert.equal(budget!.amount_sgd, 80000);
});

test('buildAssistantReply removes a budget when the action indicates removal', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { setBudget, findBudgetByCategory } = await import('../budget/service');
  await setBudget(userId, 'Travel', 200, 'SGD');

  const reply = await buildAssistantReply(userId, {
    intent: 'budget',
    confidence: 0.9,
    extracted: { category: 'Travel', action: 'remove' },
    rawText: 'Remove my travel budget',
  });

  assert.match(reply, /removed/i);
  assert.match(reply, /Travel/);

  const budget = await findBudgetByCategory(userId, 'Travel');
  assert.equal(budget, null);
});

test('buildAssistantReply asks for a category when the budget intent has none', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'budget',
    confidence: 0.5,
    extracted: {},
    rawText: 'set a budget',
  });

  assert.match(reply, /which category/i);
});

test('buildAssistantReply records a new crypto holding for the holdings intent', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'BTC', amount: 0.5, assetClass: 'crypto', currency: 'USD' },
    rawText: 'I hold 0.5 BTC',
  });

  assert.match(reply, /BTC/);

  const { listHoldings } = await import('../portfolio/service');
  const allHoldings = await listHoldings(userId);
  const btc = allHoldings.find((h) => h.symbol === 'BTC');

  assert.ok(btc);
  assert.equal(btc!.quantity, 0.5);
  assert.equal(btc!.broker, null);
});

test('buildAssistantReply removes a holding when the action indicates removal', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { addHolding, listHoldings } = await import('../portfolio/service');
  await addHolding(userId, { symbol: 'ETH', name: 'ETH', quantity: 1, asset_class: 'crypto', currency: 'USD', market: 'Crypto' });

  const reply = await buildAssistantReply(userId, {
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'ETH', action: 'remove' },
    rawText: 'Remove my ETH holding',
  });

  assert.match(reply, /removed/i);

  const allHoldings = await listHoldings(userId);
  assert.ok(!allHoldings.some((h) => h.symbol === 'ETH'));
});

test('buildAssistantReply points a stock mentioned in chat to statement upload, rather than recording it', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'AAPL', amount: 10, assetClass: 'stocks_us', currency: 'USD' },
    rawText: 'I hold 10 AAPL',
  });

  assert.match(reply, /statement/i);

  const { listHoldings } = await import('../portfolio/service');
  const allHoldings = await listHoldings(userId);
  assert.ok(!allHoldings.some((h) => h.symbol === 'AAPL'), 'a stock has no price source outside a statement');
});

test('buildAssistantReply falls back to USD when the holdings intent has an unrecognized currency', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'DOGE', amount: 100, assetClass: 'crypto', currency: 'HKD' },
    rawText: 'I hold 100 DOGE',
  });

  assert.match(reply, /DOGE/);

  const { listHoldings } = await import('../portfolio/service');
  const allHoldings = await listHoldings(userId);
  const doge = allHoldings.find((h) => h.symbol === 'DOGE');

  assert.ok(doge);
  assert.equal(doge!.currency, 'USD');
});

test('buildAssistantReply asks whether an unknown symbol is a coin or a stock rather than guessing crypto', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'XYZ', amount: 5 },
    rawText: 'I hold 5 XYZ',
  });

  assert.match(reply, /crypto coin/i);
  assert.match(reply, /statement/i);
  const { listHoldings } = await import('../portfolio/service');
  assert.ok(!(await listHoldings(userId)).some((h) => h.symbol === 'XYZ'));
});

test('buildAssistantReply infers crypto for a listed coin even without an asset class', async () => {
  const { buildAssistantReply } = await import('./ai');
  await buildAssistantReply(userId, {
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'sol', amount: 2 },
    rawText: 'I hold 2 SOL',
  });

  const { listHoldings } = await import('../portfolio/service');
  const sol = (await listHoldings(userId)).find((h) => h.symbol === 'SOL');
  assert.equal(sol?.asset_class, 'crypto');
});

test('buildAssistantReply warns when a crypto coin has no price source', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'FOOCOIN', amount: 5, assetClass: 'crypto' },
    rawText: 'I hold 5 FOOCOIN',
  });

  assert.match(reply, /no price source|don't have a price source/i);
});

test('buildAssistantReply explains a statement holding cannot be removed by hand, instead of claiming it was', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { replaceHoldingsForBroker, listHoldings } = await import('../portfolio/service');
  await replaceHoldingsForBroker(userId, 'ibkr', [
    { symbol: 'MSFT', name: 'Microsoft', quantity: 3, asset_class: 'stocks_us', currency: 'USD', market: 'NASDAQ' },
  ]);

  const reply = await buildAssistantReply(userId, {
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'MSFT', action: 'remove' },
    rawText: 'Remove my MSFT holding',
  });

  assert.match(reply, /IBKR statement/);
  assert.doesNotMatch(reply, /Done/);
  assert.ok((await listHoldings(userId)).some((h) => h.symbol === 'MSFT'));
});

test('buildAssistantReply says so when there is nothing to remove', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'NOTHELD', action: 'remove' },
    rawText: 'Remove NOTHELD',
  });

  assert.match(reply, /don't have a NOTHELD holding/i);
});

test('buildAssistantReply points a stock to statement upload even when a statement already holds it', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'holdings',
    confidence: 0.9,
    extracted: { symbol: 'MSFT', amount: 5, assetClass: 'stocks_us' },
    rawText: 'I hold 5 MSFT shares',
  });

  assert.match(reply, /statement/i);
  const { listHoldings } = await import('../portfolio/service');
  assert.equal((await listHoldings(userId)).filter((h) => h.symbol === 'MSFT').length, 1);
});

test('buildAssistantReply asks which holding when the holdings intent has no symbol', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'holdings',
    confidence: 0.5,
    extracted: {},
    rawText: 'I have some crypto',
  });

  assert.match(reply, /which holding/i);
});

test('buildAssistantReply answers a query intent with real spending data', async () => {
  const { stubGeminiCategorization } = await import('../testing/geminiStub');
  const restoreGemini = stubGeminiCategorization();

  try {
    const { getSpendingSummary, logExpense } = await import('../expense/service');
    const before = await getSpendingSummary(userId, 'today');

    await logExpense(userId, { amount: 10, merchant: 'Fairprice', source: 'text' });

    const { buildAssistantReply } = await import('./ai');
    const reply = await buildAssistantReply(userId, {
      intent: 'query',
      confidence: 0.8,
      extracted: { period: 'today' },
      rawText: 'How much did I spend today?',
    });

    const after = await getSpendingSummary(userId, 'today');
    assert.equal(after.count, before.count + 1);
    assert.match(reply, new RegExp(`${(after.total / 100).toFixed(2)}`));
    assert.match(reply, new RegExp(String(after.count)));
  } finally {
    restoreGemini();
  }
});

test('buildAssistantReply falls back to a month query when period is not recognized', async () => {
  const { getSpendingSummary } = await import('../expense/service');
  const { buildAssistantReply } = await import('./ai');
  const monthSummary = await getSpendingSummary(userId, 'month');

  const reply = await buildAssistantReply(userId, {
    intent: 'query',
    confidence: 0.5,
    extracted: { period: 'this year' },
    rawText: 'how much have I spent',
  });

  assert.match(reply, new RegExp(`${(monthSummary.total / 100).toFixed(2)}`));
});

test('buildAssistantReply creates a real recurring transaction for the recurring intent', async () => {
  const { stubGeminiCategorization } = await import('../testing/geminiStub');
  const restoreGemini = stubGeminiCategorization();

  try {
    const { buildAssistantReply } = await import('./ai');
    const reply = await buildAssistantReply(userId, {
      intent: 'recurring',
      confidence: 0.9,
      extracted: { amount: 15.98, merchant: 'Netflix', dayOfMonth: 5 },
      rawText: 'Netflix $15.98 every 5th',
    });

    assert.match(reply, /Netflix/i);
    assert.match(reply, /5/);

    const { listRecurring } = await import('../expense/service');
    const all = await listRecurring(userId);
    const netflix = all.find((r) => r.merchant === 'Netflix');

    assert.ok(netflix);
    assert.equal(netflix.amount, 1598);
    assert.equal(netflix.day_of_month, 5);
  } finally {
    restoreGemini();
  }
});

test('buildAssistantReply asks for a day of month when the recurring intent has none', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'recurring',
    confidence: 0.6,
    extracted: { amount: 15.98, merchant: 'Netflix' },
    rawText: 'Netflix $15.98 monthly',
  });

  assert.match(reply, /which day|day of the month/i);
});

test('buildAssistantReply asks which merchant when the recurring intent has none', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'recurring',
    confidence: 0.5,
    extracted: {},
    rawText: 'set up a recurring payment',
  });

  assert.match(reply, /which (merchant|subscription|recurring)/i);
});

test('buildAssistantReply removes a recurring transaction matched by merchant', async () => {
  const { stubGeminiCategorization } = await import('../testing/geminiStub');
  const restoreGemini = stubGeminiCategorization();

  try {
    const { createRecurring, listRecurring } = await import('../expense/service');
    await createRecurring(userId, { amount: 9.9, merchant: 'Spotify', day_of_month: 1 });

    const { buildAssistantReply } = await import('./ai');
    const reply = await buildAssistantReply(userId, {
      intent: 'recurring',
      confidence: 0.9,
      extracted: { merchant: 'Spotify', action: 'remove' },
      rawText: 'Cancel my Spotify subscription',
    });

    assert.match(reply, /removed/i);
    assert.match(reply, /Spotify/i);

    const all = await listRecurring(userId);
    assert.ok(!all.some((r) => r.merchant === 'Spotify'));
  } finally {
    restoreGemini();
  }
});

test('buildAssistantReply tells the user when no matching recurring entry is found to remove', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, {
    intent: 'recurring',
    confidence: 0.7,
    extracted: { merchant: 'NonexistentThing', action: 'remove' },
    rawText: 'cancel NonexistentThing',
  });

  assert.match(reply, /couldn.?t find/i);
});

// --- expense tracking and budgeting ---------------------------------------------

// Each of these gets its own user, so spending and budgets from other tests in
// this file can't shift the numbers.
async function freshUser(chatId: string): Promise<string> {
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const user = await createUser(chatId);
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-stubbed-tests'), true);
  return user.id;
}

function expense(amount: number, merchant: string, currency?: string) {
  return {
    intent: 'expense' as const,
    confidence: 0.95,
    extracted: { amount, merchant, ...(currency ? { currency } : {}) },
    rawText: `Spent ${amount} at ${merchant}`,
  };
}

function correction(extracted: Record<string, unknown>, rawText = 'actually that was wrong') {
  return { intent: 'correction' as const, confidence: 0.9, extracted, rawText };
}

async function withCategorizer<T>(run: () => Promise<T>): Promise<T> {
  const { stubGeminiCategorization } = await import('../testing/geminiStub');
  const restore = stubGeminiCategorization();
  try {
    return await run();
  } finally {
    restore();
  }
}

test('an expense that crosses a budget threshold adds the alert to the reply, once per threshold', async () => {
  await withCategorizer(async () => {
    const { buildAssistantReply } = await import('./ai');
    const { setBudget } = await import('../budget/service');
    const owner = await freshUser('test-ai-alert-chat');
    await setBudget(owner, 'Transport', 20, 'SGD');

    assert.doesNotMatch(await buildAssistantReply(owner, expense(10, 'Grab')), /budget alert/);
    assert.match(await buildAssistantReply(owner, expense(7, 'Grab')), /Transport budget alert: you've used 80%/);
    assert.match(await buildAssistantReply(owner, expense(5, 'Grab')), /Transport budget alert: you've hit 100%/);
    assert.doesNotMatch(
      await buildAssistantReply(owner, expense(1, 'Grab')),
      /budget alert/,
      'each threshold alerts once a month',
    );
  });
});

test('an expense in ringgit is confirmed in ringgit and in SGD', async () => {
  await withCategorizer(async () => {
    const { buildAssistantReply } = await import('./ai');
    const owner = await freshUser('test-ai-myr-expense-chat');

    const reply = await buildAssistantReply(owner, expense(45, 'Kopitiam', 'MYR'));

    assert.match(reply, /RM45\.00 \(S\$14\.02\)/);
  });
});

test('a budget is set in the currency the user named', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { findBudgetByCategory } = await import('../budget/service');
  const owner = await freshUser('test-ai-budget-currency-chat');

  const reply = await buildAssistantReply(owner, {
    intent: 'budget',
    confidence: 0.9,
    extracted: { category: 'Shopping', budgetAmount: 500, currency: 'MYR' },
    rawText: 'Set shopping budget to RM 500',
  });

  assert.match(reply, /RM500\.00 \(S\$155\.76\)/);
  const budget = await findBudgetByCategory(owner, 'Shopping');
  assert.equal(budget?.currency, 'MYR');
  assert.equal(budget?.amount, 50000);
  assert.equal(budget?.amount_sgd, 15576);
});

test('a budget for a category that is not one of ours gets a question, not an "Others" budget', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { listBudgets } = await import('../budget/service');
  const owner = await freshUser('test-ai-budget-unknown-category-chat');

  const reply = await buildAssistantReply(owner, {
    intent: 'budget',
    confidence: 0.9,
    extracted: { category: 'coffee', budgetAmount: 50 },
    rawText: 'Set coffee budget to $50',
  });

  assert.match(reply, /Budgets are set per category/);
  assert.equal((await listBudgets(owner)).length, 0);
});

test('removing a budget that does not exist says so', async () => {
  const { buildAssistantReply } = await import('./ai');
  const owner = await freshUser('test-ai-budget-remove-missing-chat');

  const reply = await buildAssistantReply(owner, {
    intent: 'budget',
    confidence: 0.9,
    extracted: { category: 'Health', action: 'remove' },
    rawText: 'Remove my health budget',
  });

  assert.match(reply, /don't have a Health budget/);
});

test('a correction can change the currency, keeping the amount and category', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { getTopExpenses } = await import('../expense/service');
  const owner = await freshUser('test-ai-correct-currency-chat');
  await withCategorizer(() => buildAssistantReply(owner, expense(45, 'Kopitiam')));

  const reply = await buildAssistantReply(owner, correction({ currency: 'MYR' }, 'it was in ringgit'));

  assert.match(reply, /RM45\.00 \(S\$14\.02\)/);
  const [last] = await getTopExpenses(owner, 'today', 1);
  assert.equal(last.currency, 'MYR');
  assert.equal(last.amount, 4500);
  assert.equal(last.amount_sgd, 1402);
  assert.equal(last.category, 'Food', 'a currency fix must not re-categorize');
});

test('a correction applies a new currency and amount together', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { getTopExpenses } = await import('../expense/service');
  const owner = await freshUser('test-ai-correct-both-chat');
  await withCategorizer(() => buildAssistantReply(owner, expense(45, 'Kopitiam')));

  const reply = await buildAssistantReply(owner, correction({ amount: 12, currency: 'MYR' }, 'actually it was RM 12'));

  assert.match(reply, /RM12\.00 \(S\$3\.74\)/);
  const [last] = await getTopExpenses(owner, 'today', 1);
  assert.equal(last.amount, 1200);
  assert.equal(last.currency, 'MYR');
});

test('a correction uses a category the user names as-is, without asking the model', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { getTopExpenses } = await import('../expense/service');
  const owner = await freshUser('test-ai-correct-category-chat');
  await withCategorizer(() => buildAssistantReply(owner, expense(45, 'Kopitiam')));

  // If the model were consulted this would fail, and the category would become Others.
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('the categorizer should not be called');
  }) as typeof fetch;
  try {
    const reply = await buildAssistantReply(owner, correction({ category: 'groceries' }, 'that was groceries'));
    assert.match(reply, /under Groceries/);
  } finally {
    global.fetch = originalFetch;
  }

  const [last] = await getTopExpenses(owner, 'today', 1);
  assert.equal(last.category, 'Groceries');
});

test('a correction with nothing identifiable asks what to change instead of guessing', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { getTopExpenses } = await import('../expense/service');
  const owner = await freshUser('test-ai-correct-nothing-chat');
  await withCategorizer(() => buildAssistantReply(owner, expense(45, 'Kopitiam')));

  const reply = await buildAssistantReply(owner, correction({}, 'no, that is wrong'));

  assert.match(reply, /What should I change/);
  const [last] = await getTopExpenses(owner, 'today', 1);
  assert.equal(last.category, 'Food');
  assert.equal(last.amount, 4500);
});

test('a spending question about one category answers for that category, with its budget', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { setBudget } = await import('../budget/service');
  const owner = await freshUser('test-ai-category-query-chat');
  await withCategorizer(async () => {
    await buildAssistantReply(owner, expense(5, 'Kopi'));
    await buildAssistantReply(owner, expense(3, 'Kopi'));
    await buildAssistantReply(owner, expense(10, 'Grab'));
  });
  await setBudget(owner, 'Food', 100, 'SGD');

  const reply = await buildAssistantReply(owner, {
    intent: 'query',
    confidence: 0.9,
    extracted: { period: 'month', category: 'food' },
    rawText: 'How much did I spend on food this month?',
  });

  assert.equal(
    reply,
    "This month's spend on Food: S$8.00 across 2 transactions.\nThat's 8% of your S$100.00 budget, S$92.00 left.",
  );
});

test('the help intent lists every command, not a partial set', async () => {
  const { buildAssistantReply } = await import('./ai');
  const reply = await buildAssistantReply(userId, { intent: 'help', confidence: 0.9, extracted: {}, rawText: 'help' });

  for (const command of ['/today', '/month', '/budget', '/undo', '/export', '/split', '/digest']) {
    assert.ok(reply.includes(command), `help is missing ${command}`);
  }
});
