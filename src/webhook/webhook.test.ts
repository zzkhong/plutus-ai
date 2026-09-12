import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stubGeminiCategorization } from '../testing/geminiStub';

process.env.DATABASE_URL = './data/test-webhook.db';

const testDbPath = path.resolve('./data/test-webhook.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let restoreGeminiStub: () => void;

// Each user's own webhook key, captured from their users row after setup.
let approvedKey: string;
let approvedChatId: string;
let approvedUserId: string;
let pendingKey: string;
let otherApprovedKey: string;

before(async () => {
  restoreGeminiStub = stubGeminiCategorization();
  const { runMigrations } = await import('../db/migrate');
  await runMigrations();

  const { createUser, setProvider, completeSetup, approve } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');

  // An approved user (the admin bootstrap path auto-approves).
  approvedChatId = 'webhook-approved-chat';
  const approved = await createUser(approvedChatId);
  await setProvider(approved.id, 'gemini');
  const approvedComplete = await completeSetup(approved.id, encrypt('fake-key'), true);
  approvedKey = approvedComplete.webhook_api_key!;
  approvedUserId = approved.id;

  // A second approved user, to prove one user's key never touches another's data.
  const other = await createUser('webhook-other-chat');
  await setProvider(other.id, 'gemini');
  const otherComplete = await completeSetup(other.id, encrypt('fake-key'), false);
  await approve(other.id);
  otherApprovedKey = otherComplete.webhook_api_key!;

  // A user who finished setup but is still awaiting admin approval.
  const pending = await createUser('webhook-pending-chat');
  await setProvider(pending.id, 'gemini');
  const pendingComplete = await completeSetup(pending.id, encrypt('fake-key'), false);
  pendingKey = pendingComplete.webhook_api_key!;
});

after(() => {
  restoreGeminiStub();
});

function fakeBot() {
  const sent: Array<{ chatId: string; text: string }> = [];
  const bot = {
    api: {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      },
    },
  } as any;
  return { bot, sent };
}

test('GET /api/health returns ok without auth', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('POST /api/apple-pay rejects requests with no x-api-key header', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: '4.50', merchant: 'Ya Kun', card: 'DBS' }),
  });

  assert.equal(res.status, 401);
});

test('POST /api/apple-pay rejects an x-api-key that belongs to no user', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'not-a-real-users-key' },
    body: JSON.stringify({ amount: '4.50', merchant: 'Ya Kun', card: 'DBS' }),
  });

  assert.equal(res.status, 401);
});

test('POST /api/apple-pay rejects a pending user key with 403 until they are approved', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': pendingKey },
    body: JSON.stringify({ amount: '4.50', merchant: 'Ya Kun', card: 'DBS' }),
  });

  assert.equal(res.status, 403);
});

test('POST /api/apple-pay stops accepting a rejected user key immediately', async () => {
  const { createWebhookApp } = await import('./index');
  const { createUser, setProvider, completeSetup, reject } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');

  const doomed = await createUser('webhook-doomed-chat');
  await setProvider(doomed.id, 'gemini');
  const completed = await completeSetup(doomed.id, encrypt('fake-key'), true);
  const doomedKey = completed.webhook_api_key!;

  const app = createWebhookApp(null);
  const beforeReject = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': doomedKey },
    body: JSON.stringify({ amount: '1.00', merchant: 'Ya Kun', card: 'DBS' }),
  });
  assert.equal(beforeReject.status, 200);

  await reject(doomed.id);

  const afterReject = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': doomedKey },
    body: JSON.stringify({ amount: '1.00', merchant: 'Ya Kun', card: 'DBS' }),
  });
  assert.equal(afterReject.status, 401);
});

test('POST /api/apple-pay rejects a payload missing required fields', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': approvedKey },
    body: JSON.stringify({ amount: '4.50', merchant: 'Ya Kun' }),
  });

  assert.equal(res.status, 400);
});

test('POST /api/apple-pay rejects a non-numeric amount', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': approvedKey },
    body: JSON.stringify({ amount: 'not-a-number', merchant: 'Ya Kun', card: 'DBS' }),
  });

  assert.equal(res.status, 400);
});

test('POST /api/apple-pay logs the transaction and confirms on the key owner chat', async () => {
  const { createWebhookApp } = await import('./index');
  const { bot, sent } = fakeBot();
  const app = createWebhookApp(bot);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': approvedKey },
    body: JSON.stringify({ amount: '4.50', merchant: 'Ya Kun Kaya Toast', card: 'DBS' }),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.status, 'logged');
  assert.equal(body.transaction.amount, 4.5);
  assert.equal(body.transaction.currency, 'SGD');
  assert.equal(body.transaction.merchant, 'Ya Kun Kaya Toast');
  assert.ok(body.transaction.category);

  assert.equal(sent.length, 1);
  // Confirmation goes to the user who owns the key, not a globally configured chat.
  assert.equal(sent[0].chatId, approvedChatId);
  assert.match(sent[0].text, /Spent S\$4\.50 at Ya Kun Kaya Toast/);
});

test('POST /api/apple-pay logs against the user owning the key, not any other user', async () => {
  const { createWebhookApp } = await import('./index');
  const { getSpendingSummary } = await import('../expense/service');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': otherApprovedKey },
    body: JSON.stringify({ amount: '12.00', merchant: 'Other User Cafe', card: 'DBS' }),
  });
  assert.equal(res.status, 200);

  // The first user's ledger must not contain the second user's transaction.
  const summary = await getSpendingSummary(approvedUserId, 'month');
  assert.ok(
    !summary.topExpenses.some((expense) => expense.merchant === 'Other User Cafe'),
    'user A summary leaked user B webhook transaction',
  );
});

test('POST /api/apple-pay treats a currency prefix on the amount as an explicit override', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': approvedKey },
    body: JSON.stringify({ amount: 'RM 45.00', merchant: 'Kopitiam', card: 'DBS' }),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.transaction.amount, 45);
  assert.equal(body.transaction.currency, 'MYR');
});

test('POST /api/apple-pay returns 400 on a body that is not valid JSON', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': approvedKey },
    body: 'this is not json',
  });

  assert.equal(res.status, 400);
  const body = (await res.json()) as any;
  assert.equal(body.status, 'error');
});

test('POST /api/apple-pay returns 500 without crashing when logExpense fails', async () => {
  const { createApplePayHandler } = await import('./routes/apple-pay');
  const { findById } = await import('../users/service');
  const user = await findById(approvedUserId);

  const handler = createApplePayHandler(null, {
    logExpense: async () => {
      throw new Error('simulated persistence failure');
    },
  });

  const ctx = {
    get: () => user,
    req: { json: async () => ({ amount: '4.50', merchant: 'Ya Kun', card: 'DBS' }) },
    json: (body: unknown, status: number) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  } as any;

  const res = await handler(ctx);

  assert.equal(res.status, 500);
  const body = (await res.json()) as any;
  assert.equal(body.status, 'error');
});

// --- POST /api/telegram ------------------------------------------------------

const TELEGRAM_SECRET = 'tg_secret-for-tests';

function fakeTelegram(options: { failInit?: boolean } = {}) {
  const handled: any[] = [];
  const pending: Promise<unknown>[] = [];
  let inited = false;
  let initCalls = 0;

  const processor = {
    isInited: () => inited,
    init: async () => {
      initCalls += 1;
      if (options.failInit) {
        throw new Error('simulated getMe failure');
      }
      inited = true;
    },
    handleUpdate: async (update: unknown) => {
      handled.push(update);
    },
  } as any;

  return {
    processor,
    handled,
    pending,
    waitUntil: (promise: Promise<unknown>) => {
      pending.push(promise);
    },
    initCalls: () => initCalls,
  };
}

function telegramRequest(headers: Record<string, string>, body: unknown = { update_id: 1, message: { text: '/help' } }) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

test('POST /api/telegram refuses every update when TELEGRAM_WEBHOOK_SECRET is not configured', async () => {
  const { createWebhookApp } = await import('./index');
  const telegram = fakeTelegram();
  const app = createWebhookApp(null, { telegramSecret: undefined, telegram: telegram.processor, waitUntil: telegram.waitUntil });

  const res = await app.request('/api/telegram', telegramRequest({ 'x-telegram-bot-api-secret-token': 'anything' }));

  assert.equal(res.status, 503);
  assert.equal(telegram.handled.length, 0);
});

test('POST /api/telegram rejects a missing or wrong secret header, so updates cannot be forged', async () => {
  const { createWebhookApp } = await import('./index');
  const telegram = fakeTelegram();
  const app = createWebhookApp(null, { telegramSecret: TELEGRAM_SECRET, telegram: telegram.processor, waitUntil: telegram.waitUntil });

  const missing = await app.request('/api/telegram', telegramRequest({}));
  const wrong = await app.request('/api/telegram', telegramRequest({ 'x-telegram-bot-api-secret-token': 'not-the-secret' }));

  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(telegram.handled.length, 0);
});

test('POST /api/telegram acknowledges immediately and processes the update in the background', async () => {
  const { createWebhookApp } = await import('./index');
  const telegram = fakeTelegram();
  const app = createWebhookApp(null, { telegramSecret: TELEGRAM_SECRET, telegram: telegram.processor, waitUntil: telegram.waitUntil });

  const res = await app.request(
    '/api/telegram',
    telegramRequest({ 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET }, { update_id: 42, message: { text: 'hi' } }),
  );

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(telegram.pending.length, 1, 'processing should be handed to waitUntil');

  await Promise.all(telegram.pending);
  assert.equal(telegram.handled.length, 1);
  assert.equal(telegram.handled[0].update_id, 42);
});

test('POST /api/telegram initializes the bot once per instance, not once per update', async () => {
  const { createWebhookApp } = await import('./index');
  const telegram = fakeTelegram();
  const app = createWebhookApp(null, { telegramSecret: TELEGRAM_SECRET, telegram: telegram.processor, waitUntil: telegram.waitUntil });

  await app.request('/api/telegram', telegramRequest({ 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET }));
  await app.request('/api/telegram', telegramRequest({ 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET }));
  await Promise.all(telegram.pending);

  assert.equal(telegram.initCalls(), 1);
  assert.equal(telegram.handled.length, 2);
});

test('POST /api/telegram answers 500 when bot initialization fails, so Telegram retries the update', async () => {
  const { createWebhookApp } = await import('./index');
  const telegram = fakeTelegram({ failInit: true });
  const app = createWebhookApp(null, { telegramSecret: TELEGRAM_SECRET, telegram: telegram.processor, waitUntil: telegram.waitUntil });

  const res = await app.request('/api/telegram', telegramRequest({ 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET }));

  assert.equal(res.status, 500);
  assert.equal(telegram.handled.length, 0);
});

test('POST /api/telegram rejects a body that is not JSON', async () => {
  const { createWebhookApp } = await import('./index');
  const telegram = fakeTelegram();
  const app = createWebhookApp(null, { telegramSecret: TELEGRAM_SECRET, telegram: telegram.processor, waitUntil: telegram.waitUntil });

  const res = await app.request('/api/telegram', telegramRequest({ 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET }, 'not json'));

  assert.equal(res.status, 400);
});

test('POST /api/telegram answers 503 when no Telegram bot is configured', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null, { telegramSecret: TELEGRAM_SECRET });

  const res = await app.request('/api/telegram', telegramRequest({ 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET }));

  assert.equal(res.status, 503);
});

// --- GET /api/cron/* ---------------------------------------------------------

const CRON_SECRET = 'cron-secret-for-tests-123';

function fakeJobs(options: { fail?: boolean } = {}) {
  const runs = { recurring: 0, digest: 0 };
  return {
    runs,
    jobs: {
      recurring: async () => {
        runs.recurring += 1;
        if (options.fail) {
          throw new Error('simulated job failure');
        }
      },
      digest: async () => {
        runs.digest += 1;
      },
    },
  };
}

test('GET /api/cron/* refuses to run anything when CRON_SECRET is not configured', async () => {
  const { createWebhookApp } = await import('./index');
  const { runs, jobs } = fakeJobs();
  const app = createWebhookApp(null, { cronSecret: undefined, jobs });

  const res = await app.request('/api/cron/digest', { headers: { authorization: 'Bearer anything' } });

  assert.equal(res.status, 503);
  assert.equal(runs.digest, 0);
});

test('GET /api/cron/* rejects a missing or wrong bearer token', async () => {
  const { createWebhookApp } = await import('./index');
  const { runs, jobs } = fakeJobs();
  const app = createWebhookApp(null, { cronSecret: CRON_SECRET, jobs });

  const missing = await app.request('/api/cron/recurring');
  const wrong = await app.request('/api/cron/recurring', { headers: { authorization: 'Bearer wrong' } });

  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(runs.recurring, 0);
});

test('GET /api/cron/recurring and /api/cron/digest each run their own job with the right token', async () => {
  const { createWebhookApp } = await import('./index');
  const { runs, jobs } = fakeJobs();
  const app = createWebhookApp(null, { cronSecret: CRON_SECRET, jobs });
  const headers = { authorization: `Bearer ${CRON_SECRET}` };

  const recurring = await app.request('/api/cron/recurring', { headers });
  const digest = await app.request('/api/cron/digest', { headers });

  assert.equal(recurring.status, 200);
  assert.equal(digest.status, 200);
  assert.deepEqual(runs, { recurring: 1, digest: 1 });
});

test('GET /api/cron/* answers 500 when the job throws', async () => {
  const { createWebhookApp } = await import('./index');
  const { jobs } = fakeJobs({ fail: true });
  const app = createWebhookApp(null, { cronSecret: CRON_SECRET, jobs });

  const res = await app.request('/api/cron/recurring', { headers: { authorization: `Bearer ${CRON_SECRET}` } });

  assert.equal(res.status, 500);
});

test('POST /api/apple-pay adds the budget alert to the Telegram confirmation when a purchase crosses a threshold', async () => {
  const { createWebhookApp } = await import('./index');
  const { setBudget } = await import('../budget/service');
  await setBudget(approvedUserId, 'Transport', 5, 'SGD');

  const { bot, sent } = fakeBot();
  const app = createWebhookApp(bot);
  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': approvedKey },
    body: JSON.stringify({ amount: '4.50', merchant: 'Grab', card: 'DBS' }),
  });

  assert.equal(res.status, 200);
  assert.equal(sent.length, 1, 'one message: the confirmation with the alert under it');
  assert.match(sent[0].text, /Spent S\$4\.50 at Grab/);
  assert.match(sent[0].text, /Transport budget alert: you've used 80%/);
});
