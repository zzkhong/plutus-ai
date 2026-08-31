import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-webhook.db';
process.env.WEBHOOK_API_KEY = 'test-webhook-secret';
process.env.TELEGRAM_AUTHORIZED_CHAT_ID = 'test-chat-id';

const testDbPath = path.resolve('./data/test-webhook.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();
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

test('POST /api/apple-pay rejects requests with the wrong x-api-key', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'wrong-secret' },
    body: JSON.stringify({ amount: '4.50', merchant: 'Ya Kun', card: 'DBS' }),
  });

  assert.equal(res.status, 401);
});

test('POST /api/apple-pay rejects a payload missing required fields', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-webhook-secret' },
    body: JSON.stringify({ amount: '4.50', merchant: 'Ya Kun' }),
  });

  assert.equal(res.status, 400);
});

test('POST /api/apple-pay rejects a non-numeric amount', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-webhook-secret' },
    body: JSON.stringify({ amount: 'not-a-number', merchant: 'Ya Kun', card: 'DBS' }),
  });

  assert.equal(res.status, 400);
});

test('POST /api/apple-pay logs the transaction, maps card to currency, and sends a Telegram confirmation', async () => {
  const { createWebhookApp } = await import('./index');
  const { bot, sent } = fakeBot();
  const app = createWebhookApp(bot);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-webhook-secret' },
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
  assert.equal(sent[0].chatId, 'test-chat-id');
  assert.match(sent[0].text, /Spent S\$4\.50 at Ya Kun Kaya Toast/);
});

test('POST /api/apple-pay treats a currency prefix on the amount as an explicit override', async () => {
  const { createWebhookApp } = await import('./index');
  const app = createWebhookApp(null);

  const res = await app.request('/api/apple-pay', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-webhook-secret' },
    body: JSON.stringify({ amount: 'RM 45.00', merchant: 'Kopitiam', card: 'DBS' }),
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.transaction.amount, 45);
  assert.equal(body.transaction.currency, 'MYR');
});

test('POST /api/apple-pay returns 500 without crashing when logExpense fails', async () => {
  const { createWebhookApp } = await import('./index');
  const { config } = await import('../config');
  const app = createWebhookApp(null);

  const originalDatabaseUrl = config.DATABASE_URL;
  config.DATABASE_URL = 'Z:/nonexistent-drive/pluto.db';

  try {
    const res = await app.request('/api/apple-pay', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'test-webhook-secret' },
      body: JSON.stringify({ amount: '4.50', merchant: 'Ya Kun', card: 'DBS' }),
    });

    assert.equal(res.status, 500);
    const body = (await res.json()) as any;
    assert.equal(body.status, 'error');
  } finally {
    config.DATABASE_URL = originalDatabaseUrl;
  }
});
