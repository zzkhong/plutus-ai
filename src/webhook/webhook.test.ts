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
  runMigrations();

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

  // Drives the handler directly with a user id that is not in the users
  // table, so the insert trips the transactions.user_id foreign key. That is
  // a real logExpense failure rather than a stubbed one — the point of the
  // test is that the route turns a thrown error into a 500 instead of
  // crashing the webhook server.
  const handler = createApplePayHandler(null);
  const ghostUser = {
    id: 'user-id-that-does-not-exist',
    telegram_chat_id: 'ghost-chat',
    status: 'approved',
    is_admin: false,
    llm_provider: 'gemini',
    llm_api_key_encrypted: 'encrypted',
    webhook_api_key: 'ghost-key',
    created_at: new Date(),
    updated_at: new Date(),
  };

  const ctx = {
    get: () => ghostUser,
    req: { json: async () => ({ amount: '4.50', merchant: 'Ya Kun', card: 'DBS' }) },
    json: (body: unknown, status: number) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  } as any;

  const res = await handler(ctx);

  assert.equal(res.status, 500);
  const body = (await res.json()) as any;
  assert.equal(body.status, 'error');
});
