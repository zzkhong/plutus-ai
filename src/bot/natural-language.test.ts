import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-natural-language.db';

const testDbPath = path.resolve('./data/test-natural-language.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let restoreGemini: () => void;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  await runMigrations();
  const { stubGeminiCategorization } = await import('../testing/geminiStub');
  restoreGemini = stubGeminiCategorization();
});

after(() => {
  restoreGemini();
});

// A pinned day, so "last month" is always August 2026.
const now = new Date(2026, 8, 17, 15);

async function approvedUser(chatId: string): Promise<string> {
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const user = await createUser(chatId);
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-stubbed-tests'), true);
  return user.id;
}

async function spent(userId: string, merchant: string, amount: number, day: Date, extra: { photoFileId?: string } = {}) {
  const { logExpense } = await import('../expense/service');
  return logExpense(userId, { amount, merchant, source: 'text', categoryHint: 'Groceries', spentAt: day, ...extra });
}

function reply(intent: string, extracted: Record<string, unknown>, rawText = '') {
  return { intent: intent as never, confidence: 0.9, extracted, rawText };
}

function buttons(keyboard: { inline_keyboard: unknown[][] } | undefined): Array<{ text: string; callback_data: string }> {
  return (keyboard?.inline_keyboard ?? []).flat() as Array<{ text: string; callback_data: string }>;
}

function withGemini(responses: string[]): () => void {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = (async () => {
    const text = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return () => {
    global.fetch = originalFetch;
  };
}

// --- finding expenses -------------------------------------------------------------

test('findTransactions matches part of a merchant name, a category and a spent-at window, for that user only', async () => {
  const { findTransactions } = await import('../expense/service');
  const owner = await approvedUser('test-nl-find-chat');
  const stranger = await approvedUser('test-nl-find-stranger');
  await spent(owner, 'NTUC FairPrice Tampines', 40, new Date(2026, 7, 3, 12));
  await spent(owner, 'NTUC FairPrice Bedok', 25, new Date(2026, 8, 2, 12));
  await spent(owner, '100% Kopi', 3, new Date(2026, 7, 5, 12));
  await spent(stranger, 'NTUC FairPrice', 99, new Date(2026, 7, 3, 12));

  const all = await findTransactions(owner, { merchant: 'ntuc' });
  assert.deepEqual(all.map((t) => t.amount), [2500, 4000], 'newest spent first');

  const august = await findTransactions(owner, { merchant: 'ntuc', from: new Date(2026, 7, 1), to: new Date(2026, 8, 1) });
  assert.deepEqual(august.map((t) => t.merchant), ['NTUC FairPrice Tampines']);

  assert.equal((await findTransactions(owner, { merchant: '100%' })).length, 1, '% is matched literally');
  assert.equal((await findTransactions(owner, { merchant: '%' })).length, 1);
  assert.equal((await findTransactions(owner, { category: 'Groceries' })).length, 3);
});

// --- editing an older expense by describing it ---------------------------------------

test('"change my NTUC expense last month to $40" edits the one expense it describes', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { getTransaction } = await import('../expense/service');
  const userId = await approvedUser('test-nl-edit-one');
  const august = await spent(userId, 'NTUC FairPrice', 32.5, new Date(2026, 7, 12, 12));
  const latest = await spent(userId, 'Ya Kun', 5, now);

  const result = await buildAssistantReply(
    userId,
    reply('correction', { amount: 40, targetMerchant: 'NTUC', targetMonth: '2026-08' }),
    { now },
  );

  assert.match(result.text, /^Updated that expense: S\$40\.00 at NTUC FairPrice under Groceries, on 12 Aug 2026\./);
  assert.equal((await getTransaction(userId, august.id))?.amount, 4000);
  assert.equal((await getTransaction(userId, latest.id))?.amount, 500, 'the latest expense is untouched');
});

test('a described expense that matches several offers them as buttons carrying the edit, and a tap applies it', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { handleCallback } = await import('./handlers/callback');
  const { getTransaction } = await import('../expense/service');
  const userId = await approvedUser('test-nl-edit-many');
  const first = await spent(userId, 'Grab', 18, new Date(2026, 7, 3, 12));
  const second = await spent(userId, 'Grab', 12.4, new Date(2026, 7, 9, 12));

  const result = await buildAssistantReply(
    userId,
    reply('correction', { category: 'Transport', targetMerchant: 'Grab', targetMonth: '2026-08' }),
    { now },
  );

  assert.match(result.text, /several expenses at Grab in August 2026\. Which one should I change\?/);
  const choices = buttons(result.keyboard);
  assert.deepEqual(
    choices.map((button) => button.callback_data),
    [`t:f:${second.id}:category:Transport`, `t:f:${first.id}:category:Transport`],
  );
  assert.equal(choices[0].text, '9 Aug · S$12.40 · Grab');

  const pressed = await handleCallback(userId, choices[1].callback_data);
  assert.match(pressed.text ?? '', /^Updated that expense: S\$18\.00 at Grab under Transport, on 3 Aug 2026\./);
  assert.equal((await getTransaction(userId, first.id))?.category, 'Transport');
  assert.equal((await getTransaction(userId, second.id))?.category, 'Groceries', 'only the tapped one changes');
});

test('an edit too long for button data falls back to buttons that open each match', async () => {
  const { buildAssistantReply } = await import('./ai');
  const userId = await approvedUser('test-nl-edit-long');
  await spent(userId, 'Cold Storage', 30, new Date(2026, 7, 3, 12));
  await spent(userId, 'Cold Storage', 20, new Date(2026, 7, 4, 12));

  const result = await buildAssistantReply(
    userId,
    reply('correction', { merchant: 'Cold Storage Great World City', targetMerchant: 'Cold Storage' }),
    { now },
  );

  assert.match(result.text, /Tap the one you mean, then reply to it with the change/);
  for (const button of buttons(result.keyboard)) {
    assert.match(button.callback_data, /^t:v:/);
    assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
});

test('a described expense that matches nothing says so and changes nothing', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { listRecentTransactions } = await import('../expense/service');
  const userId = await approvedUser('test-nl-edit-none');
  await spent(userId, 'Ya Kun', 5, now);

  const result = await buildAssistantReply(userId, reply('correction', { amount: 9, targetMerchant: 'Starbucks' }), { now });

  assert.match(result.text, /^I couldn't find an expense at Starbucks\./);
  assert.equal((await listRecentTransactions(userId, 1))[0].amount, 500);
});

test('a reply to a confirmation still decides which expense, over any description', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { getTransaction } = await import('../expense/service');
  const userId = await approvedUser('test-nl-edit-reply');
  const repliedTo = await spent(userId, 'Grab', 18, new Date(2026, 7, 3, 12));
  const other = await spent(userId, 'Grab', 12, new Date(2026, 7, 9, 12));

  await buildAssistantReply(userId, reply('correction', { amount: 20, targetMerchant: 'Grab' }), {
    now,
    targetTransactionId: repliedTo.id,
  });

  assert.equal((await getTransaction(userId, repliedTo.id))?.amount, 2000);
  assert.equal((await getTransaction(userId, other.id))?.amount, 1200);
});

test('edit buttons are validated like any other callback data', async () => {
  const { parseCallbackData } = await import('./keyboards');
  const id = '0b5f8a3e-6a52-4a8e-9a55-4b6f2a1c9d10';

  assert.deepEqual(parseCallbackData(`t:f:${id}:amount:40`), {
    kind: 'apply-edit',
    transactionId: id,
    edit: { field: 'amount', value: '40' },
  });
  assert.deepEqual(parseCallbackData(`t:f:${id}:date:2026-08-03`)?.kind, 'apply-edit');
  assert.deepEqual(parseCallbackData(`t:p:c:${id}`), { kind: 'split', ctx: 'c', transactionId: id });

  assert.equal(parseCallbackData(`t:f:${id}:amount:-5`), null);
  assert.equal(parseCallbackData(`t:f:${id}:currency:THB`), null);
  assert.equal(parseCallbackData(`t:f:${id}:category:Crypto`), null);
  assert.equal(parseCallbackData(`t:f:${id}:date:2026-02-31`), null);
  assert.equal(parseCallbackData(`t:f:${id}:user_id:someone`), null, 'only editable fields');
  assert.equal(parseCallbackData(`t:p:c:${id}:extra`), null);
});

// --- browsing -----------------------------------------------------------------------

test('"show my NTUC expenses last month" lists the matches as buttons', async () => {
  const { buildAssistantReply } = await import('./ai');
  const userId = await approvedUser('test-nl-browse');
  await spent(userId, 'NTUC FairPrice', 40, new Date(2026, 7, 3, 12));
  await spent(userId, 'NTUC FairPrice', 25, new Date(2026, 8, 2, 12));

  const result = await buildAssistantReply(userId, reply('find', { targetMerchant: 'NTUC', targetMonth: '2026-08' }), { now });

  assert.match(result.text, /^One expense at NTUC in August 2026, newest first\./);
  assert.equal(buttons(result.keyboard).length, 1);

  const none = await buildAssistantReply(userId, reply('find', { targetDate: '2026-08-20' }), { now });
  assert.equal(none.text, 'No expenses on 20 Aug 2026.');

  const recent = await buildAssistantReply(userId, reply('find', {}), { now });
  assert.match(recent.text, /^Your last 2 expenses/, 'with nothing to narrow it, the same as /recent');
});

// --- commands, in words -----------------------------------------------------------------

test('"send me my expenses as a spreadsheet" replies with the CSV as a document', async () => {
  const { buildAssistantReply } = await import('./ai');
  const userId = await approvedUser('test-nl-export');
  await spent(userId, 'Ya Kun', 5, new Date(2026, 7, 3, 12));
  await spent(userId, 'Old Chang Kee', 3, new Date(2025, 4, 3, 12));

  const thisYear = await buildAssistantReply(userId, reply('export', {}), { now });
  assert.equal(thisYear.text, '1 expense from 2026.');
  assert.match(thisYear.document?.filename ?? '', /2026/);
  assert.match(thisYear.document?.content ?? '', /Ya Kun/);

  const lastYear = await buildAssistantReply(userId, reply('export', { year: 2025 }), { now });
  assert.match(lastYear.document?.content ?? '', /Old Chang Kee/);

  const empty = await buildAssistantReply(userId, reply('export', { year: 2024 }), { now });
  assert.equal(empty.document, undefined);
  assert.match(empty.text, /no expenses logged in 2024/);
});

test('budgets, undo, the digest, the review and the portfolio answer in words the way their commands do', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { handleBudgetCommand } = await import('./commands/budget');
  const { listRecentTransactions } = await import('../expense/service');
  const userId = await approvedUser('test-nl-commands');

  assert.equal(
    (await buildAssistantReply(userId, reply('budget', { action: 'list' }), { now })).text,
    await handleBudgetCommand(userId),
  );

  await spent(userId, 'Ya Kun', 5, now);
  await buildAssistantReply(userId, reply('undo', {}), { now });
  assert.equal((await listRecentTransactions(userId, 5)).length, 0);

  const review = await buildAssistantReply(userId, reply('review', {}), { now });
  assert.match(review.text, /nothing/i, 'no August expenses to review');

  const portfolio = await buildAssistantReply(userId, reply('portfolio', {}), { now });
  assert.ok(portfolio.text.length > 0);
});

// --- splitting a receipt already logged ------------------------------------------------------

const itemizedReceipt = JSON.stringify({
  merchant: 'Tim Ho Wan',
  items: [
    { name: 'Char Siew Bao', price: 20 },
    { name: 'Har Gow', price: 28.2 },
  ],
  taxAndTip: 0,
  total: 48.2,
  currency: 'SGD',
});

test('Split this reads the logged receipt again, opens the split, and only then removes the expense', async () => {
  const { handleCallback } = await import('./handlers/callback');
  const { getTransaction } = await import('../expense/service');
  const { getSplitState } = await import('../split/state');
  const userId = await approvedUser('test-nl-split-button');
  const chatId = 7101;
  const receipt = await spent(userId, 'Tim Ho Wan', 48.2, now, { photoFileId: 'file-thw' });
  const downloaded: string[] = [];

  const restore = withGemini([itemizedReceipt]);
  let outcome;
  try {
    outcome = await handleCallback(userId, `t:p:c:${receipt.id}`, {
      chatId,
      downloadFile: async (fileId) => {
        downloaded.push(fileId);
        return Buffer.from('jpeg');
      },
    });
  } finally {
    restore();
  }

  assert.deepEqual(downloaded, ['file-thw']);
  assert.match(outcome.text ?? '', /Removed the S\$48\.20 expense at Tim Ho Wan/);
  assert.match(outcome.text ?? '', /2 items\. Should I split it evenly/);
  assert.equal(outcome.keyboard, null);
  assert.equal(await getTransaction(userId, receipt.id), null);
  assert.equal((await getSplitState(chatId))?.stage, 'awaiting_instructions');
});

test('a receipt whose items cannot be read keeps its expense and opens no split', async () => {
  const { handleCallback } = await import('./handlers/callback');
  const { getTransaction } = await import('../expense/service');
  const { getSplitState } = await import('../split/state');
  const userId = await approvedUser('test-nl-split-fail');
  const chatId = 7102;
  const receipt = await spent(userId, 'Tim Ho Wan', 48.2, now, { photoFileId: 'file-thw' });

  const restore = withGemini(['not json']);
  let outcome;
  try {
    outcome = await handleCallback(userId, `t:p:c:${receipt.id}`, { chatId, downloadFile: async () => Buffer.from('jpeg') });
  } finally {
    restore();
  }

  assert.match(outcome.toast ?? '', /kept the expense/);
  assert.equal(outcome.text, undefined, 'the confirmation and its buttons stay');
  assert.ok(await getTransaction(userId, receipt.id));
  assert.equal(await getSplitState(chatId), undefined);
});

test('"split this" splits the receipt just logged; "split a bill" starts a fresh split', async () => {
  const { buildAssistantReply } = await import('./ai');
  const { getTransaction } = await import('../expense/service');
  const { getSplitState, clearSplit } = await import('../split/state');
  const userId = await approvedUser('test-nl-split-words');
  const receipt = await spent(userId, 'Tim Ho Wan', 48.2, now, { photoFileId: 'file-thw' });
  const downloadFile = async () => Buffer.from('jpeg');

  const restore = withGemini([itemizedReceipt]);
  try {
    const splitThis = await buildAssistantReply(userId, reply('split', { action: 'last' }), { now, chatId: 7103, downloadFile });
    assert.match(splitThis.text, /Removed the S\$48\.20 expense/);
  } finally {
    restore();
  }
  assert.equal(await getTransaction(userId, receipt.id), null);
  assert.equal((await getSplitState(7103))?.stage, 'awaiting_instructions');
  await clearSplit(7103);

  const fresh = await buildAssistantReply(userId, reply('split', {}), { now, chatId: 7104, downloadFile });
  assert.match(fresh.text, /Send me a photo of the receipt/);
  assert.equal((await getSplitState(7104))?.stage, 'awaiting_photo');
});

test('saying "cancel" inside a split stops it, without the slash command', async () => {
  const { handleSplitCommand, handleSplitTextMessage } = await import('./commands/split');
  const { getSplitState } = await import('../split/state');
  const userId = await approvedUser('test-nl-split-replies');

  await handleSplitCommand(7105);
  assert.equal(await handleSplitTextMessage(7105, userId, 'cancel'), 'Split cancelled.');
  assert.equal(await getSplitState(7105), undefined);
});
