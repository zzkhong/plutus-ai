import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-callback.db';

const testDbPath = path.resolve('./data/test-callback.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let restoreGemini: () => void;

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  await runMigrations();
  const { stubGeminiCategorization } = await import('../../testing/geminiStub');
  restoreGemini = stubGeminiCategorization();
});

after(() => {
  restoreGemini();
});

async function approvedUser(chatId: string): Promise<string> {
  const { createUser, setProvider, completeSetup } = await import('../../users/service');
  const { encrypt } = await import('../../users/crypto');
  const user = await createUser(chatId);
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-stubbed-tests'), true);
  return user.id;
}

async function logged(userId: string, merchant = 'Button Cafe') {
  const { logExpense } = await import('../../expense/service');
  return logExpense(userId, { amount: 8.5, merchant, source: 'text', categoryHint: 'Food' });
}

function callbackData(keyboard: { inline_keyboard: unknown[][] } | null | undefined): string[] {
  return (keyboard?.inline_keyboard ?? []).flat().map((button: any) => button.callback_data ?? '');
}

// --- callback data --------------------------------------------------------------

test('parseCallbackData reads every button the bot makes, and nothing else', async () => {
  const { parseCallbackData } = await import('../keyboards');
  const id = '0b5f8a3e-6a52-4a8e-9a55-4b6f2a1c9d10';

  assert.deepEqual(parseCallbackData(`t:s:c:${id}:Transport`), {
    kind: 'set-category',
    ctx: 'c',
    transactionId: id,
    category: 'Transport',
  });
  assert.deepEqual(parseCallbackData(`t:v:${id}`), { kind: 'view', transactionId: id });
  assert.deepEqual(parseCallbackData('r:l'), { kind: 'recent' });
  assert.deepEqual(parseCallbackData(`i:d:${id}`), { kind: 'delete-income', incomeId: id });

  assert.equal(parseCallbackData(`t:s:c:${id}:Crypto`), null, 'not a category');
  assert.equal(parseCallbackData(`t:d:x:${id}`), null, 'unknown button context');
  assert.equal(parseCallbackData('t:d:c:not-an-id'), null);
  assert.equal(parseCallbackData(`t:d:c:${id}:extra`), null);
  assert.equal(parseCallbackData('something else'), null);
});

test('callback data stays within Telegram\'s 64-byte limit', async () => {
  const { categoryPicker, transactionActions } = await import('../keyboards');
  const id = '0b5f8a3e-6a52-4a8e-9a55-4b6f2a1c9d10';

  for (const data of [...callbackData(categoryPicker(id, 'r')), ...callbackData(transactionActions(id, 'r'))]) {
    assert.ok(Buffer.byteLength(data) <= 64, `${data} is too long`);
  }
});

test('transactionIdFromMarkup finds the transaction a confirmation is about', async () => {
  const { incomeActions, transactionActions, transactionIdFromMarkup } = await import('../keyboards');
  const id = '0b5f8a3e-6a52-4a8e-9a55-4b6f2a1c9d10';

  assert.equal(transactionIdFromMarkup(transactionActions(id)), id);
  assert.equal(transactionIdFromMarkup(transactionActions(id, 'r')), id);
  assert.equal(transactionIdFromMarkup(incomeActions(id)), null, 'income buttons are not a transaction');
  assert.equal(transactionIdFromMarkup(undefined), null);
});

// --- button presses ---------------------------------------------------------------

test('Change category shows the picker, a pick moves the expense, and Back returns', async () => {
  const { handleCallback } = await import('./callback');
  const { getTransaction } = await import('../../expense/service');
  const owner = await approvedUser('test-callback-category-chat');
  const expense = await logged(owner);

  const picker = await handleCallback(owner, `t:c:c:${expense.id}`);
  assert.equal(picker.text, undefined, 'the message text stays');
  assert.ok(callbackData(picker.keyboard).includes(`t:s:c:${expense.id}:Transport`));
  assert.ok(callbackData(picker.keyboard).includes(`t:b:c:${expense.id}`));

  const moved = await handleCallback(owner, `t:s:c:${expense.id}:Transport`);
  assert.equal(moved.toast, 'Moved to Transport');
  assert.equal(moved.text, 'Updated: S$8.50 at Button Cafe under Transport.');
  assert.deepEqual(callbackData(moved.keyboard), [`t:c:c:${expense.id}`, `t:d:c:${expense.id}`]);
  assert.equal((await getTransaction(owner, expense.id))?.category, 'Transport');

  const back = await handleCallback(owner, `t:b:c:${expense.id}`);
  assert.deepEqual(callbackData(back.keyboard), [`t:c:c:${expense.id}`, `t:d:c:${expense.id}`]);
});

test('picking the category an expense already has changes nothing', async () => {
  const { handleCallback } = await import('./callback');
  const owner = await approvedUser('test-callback-same-category-chat');
  const expense = await logged(owner);

  const outcome = await handleCallback(owner, `t:s:c:${expense.id}:Food`);

  assert.equal(outcome.toast, 'Already under Food');
  assert.equal(outcome.text, undefined);
});

test('moving an expense into a budgeted category reports the alert it triggers', async () => {
  const { handleCallback } = await import('./callback');
  const { setBudget } = await import('../../budget/service');
  const owner = await approvedUser('test-callback-alert-chat');
  await setBudget(owner, 'Transport', 10, 'SGD');
  const expense = await logged(owner);

  const outcome = await handleCallback(owner, `t:s:c:${expense.id}:Transport`);

  assert.match(outcome.text ?? '', /Transport budget alert: you've used 80%/);
});

test('Undo deletes the expense and removes the buttons; a second press says it is gone', async () => {
  const { handleCallback } = await import('./callback');
  const { getTransaction } = await import('../../expense/service');
  const owner = await approvedUser('test-callback-undo-chat');
  const expense = await logged(owner);

  const removed = await handleCallback(owner, `t:d:c:${expense.id}`);
  assert.equal(removed.text, 'Removed S$8.50 at Button Cafe.');
  assert.equal(removed.keyboard, null);
  assert.equal(await getTransaction(owner, expense.id), null);

  const again = await handleCallback(owner, `t:d:c:${expense.id}`);
  assert.match(again.toast ?? '', /already been deleted/);
  assert.equal(again.keyboard, null);
});

test("pressing a button with another user's transaction id changes nothing", async () => {
  const { handleCallback } = await import('./callback');
  const { getTransaction } = await import('../../expense/service');
  const owner = await approvedUser('test-callback-owner-chat');
  const intruder = await approvedUser('test-callback-intruder-chat');
  const expense = await logged(owner);

  await handleCallback(intruder, `t:s:c:${expense.id}:Travel`);
  await handleCallback(intruder, `t:d:c:${expense.id}`);

  assert.equal((await getTransaction(owner, expense.id))?.category, 'Food');
});

test('a malformed or stale button is answered, not an error', async () => {
  const { handleCallback } = await import('./callback');
  const owner = await approvedUser('test-callback-stale-chat');

  const outcome = await handleCallback(owner, 'x:unknown');

  assert.match(outcome.toast ?? '', /doesn't work any more/);
  assert.equal(outcome.keyboard, null);
});

// --- /recent ----------------------------------------------------------------------------

test('/recent lists expenses as buttons, newest first, each opening that expense', async () => {
  const { handleRecentCommand } = await import('../commands/recent');
  const { handleCallback } = await import('./callback');
  const owner = await approvedUser('test-callback-recent-chat');
  const older = await logged(owner, 'Older Kopitiam');
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = await logged(owner, 'Newer Kopitiam');

  const list = await handleRecentCommand(owner);
  assert.match(list.text, /Your last 2 expenses, newest first/);
  assert.deepEqual(callbackData(list.keyboard), [`t:v:${newer.id}`, `t:v:${older.id}`]);
  assert.match((list.keyboard!.inline_keyboard[0][0] as any).text, /S\$8\.50 · Newer Kopitiam$/);

  const opened = await handleCallback(owner, `t:v:${older.id}`);
  assert.match(opened.text ?? '', /^S\$8\.50 at Older Kopitiam — Food, /);
  assert.match(opened.text ?? '', /reply to this message/);
  assert.deepEqual(callbackData(opened.keyboard), [`t:c:r:${older.id}`, `t:d:r:${older.id}`, 'r:l']);

  const deleted = await handleCallback(owner, `t:d:r:${older.id}`);
  assert.deepEqual(callbackData(deleted.keyboard), ['r:l'], 'offers the way back to the list');

  const backToList = await handleCallback(owner, 'r:l');
  assert.match(backToList.text ?? '', /Your last expense, newest first/);
  assert.deepEqual(callbackData(backToList.keyboard), [`t:v:${newer.id}`]);
});

test('/recent with nothing logged says so, without buttons', async () => {
  const { handleRecentCommand } = await import('../commands/recent');
  const owner = await approvedUser('test-callback-recent-empty-chat');

  const reply = await handleRecentCommand(owner);

  assert.match(reply.text, /Nothing logged yet/);
  assert.equal(reply.keyboard, undefined);
});

test("income's Undo button removes that income, once", async () => {
  const { handleCallback } = await import('./callback');
  const { logIncome, listIncomeBetween } = await import('../../income/service');
  const owner = await approvedUser('test-callback-income-chat');
  const entry = await logIncome(owner, { amount: 5000, source: 'Salary' });

  const removed = await handleCallback(owner, `i:d:${entry.id}`);
  assert.equal(removed.text, 'Removed S$5000.00 of income from Salary.');
  assert.equal((await listIncomeBetween(owner, new Date(0), new Date(Date.now() + 86_400_000))).length, 0);

  const again = await handleCallback(owner, `i:d:${entry.id}`);
  assert.match(again.toast ?? '', /already removed/);
});

// --- picking a coin on CoinGecko ------------------------------------------------------

test('parseCallbackData reads the coin picker buttons', async () => {
  const { parseCallbackData } = await import('../keyboards');

  assert.deepEqual(parseCallbackData('h:g:WIF:80'), { kind: 'pick-coin', symbol: 'WIF', rank: 80 });
  assert.deepEqual(parseCallbackData('h:n:WIF'), { kind: 'skip-coin', symbol: 'WIF' });
  assert.equal(parseCallbackData('h:g:wif:80'), null, 'symbols are stored upper-case');
  assert.equal(parseCallbackData('h:g:WIF:eighty'), null);
  assert.equal(parseCallbackData('h:x:WIF'), null);
});

function coinSearch(coins: unknown[]): () => void {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(JSON.stringify({ coins }), { status: 200 })) as typeof fetch;
  return () => {
    global.fetch = originalFetch;
  };
}

const WIF = { symbol: 'WIF', name: 'WIF', quantity: 100, asset_class: 'crypto' as const, currency: 'USD' as const, market: 'Crypto' };

test('picking a coin prices the holding by that coin from then on', async () => {
  const { handleCallback } = await import('./callback');
  const { addHolding, listHoldings } = await import('../../portfolio/service');
  const owner = await approvedUser('test-callback-coin-chat');
  await addHolding(owner, WIF);

  const restore = coinSearch([
    { id: 'dogwifhat', name: 'dogwifhat', symbol: 'WIF', market_cap_rank: 80 },
    { id: 'wif-2', name: 'Wif 2', symbol: 'WIF', market_cap_rank: 3000 },
  ]);
  let outcome;
  try {
    outcome = await handleCallback(owner, 'h:g:WIF:80');
  } finally {
    restore();
  }

  assert.equal(outcome.text, 'Got it — your WIF is dogwifhat, priced live from CoinGecko. /portfolio includes it now.');
  assert.equal(outcome.keyboard, null);
  assert.equal((await listHoldings(owner)).find((h) => h.symbol === 'WIF')?.coingecko_id, 'dogwifhat');
});

test('a coin that CoinGecko no longer lists at that rank keeps the picker and says so', async () => {
  const { handleCallback } = await import('./callback');
  const { addHolding, listHoldings } = await import('../../portfolio/service');
  const owner = await approvedUser('test-callback-coin-moved-chat');
  await addHolding(owner, WIF);

  const restore = coinSearch([{ id: 'dogwifhat', name: 'dogwifhat', symbol: 'WIF', market_cap_rank: 81 }]);
  let outcome;
  try {
    outcome = await handleCallback(owner, 'h:g:WIF:80');
  } finally {
    restore();
  }

  assert.match(outcome.toast ?? '', /couldn't confirm that coin/);
  assert.equal(outcome.keyboard, undefined, 'the buttons stay');
  assert.equal((await listHoldings(owner)).find((h) => h.symbol === 'WIF')?.coingecko_id, null);
});

test('"None of these" leaves the coin unpriced', async () => {
  const { handleCallback } = await import('./callback');
  const owner = await approvedUser('test-callback-coin-skip-chat');

  const outcome = await handleCallback(owner, 'h:n:WIF');

  assert.equal(outcome.text, 'OK — WIF stays without a price, so it counts as S$0 in your net worth.');
  assert.equal(outcome.keyboard, null);
});
