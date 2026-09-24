import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-web.db';

const testDbPath = path.resolve('./data/test-web.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

const BOT_TOKEN = '123456:test-bot-token-not-a-real-one';
const SESSION_SECRET = 'a-web-session-secret-that-is-long-enough';
// Pinned inside September 2026, so "this month" doesn't depend on today.
const NOW = new Date(2026, 8, 20, 15);

// Telegram user ids double as private chat ids, which is what /setup stores.
const OWNER_TG = 710001;
const OTHER_TG = 710002;
const PENDING_TG = 710003;
const ADMIN_TG = 710004;

let ownerId: string;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  await runMigrations();

  const { createUser, setProvider, completeSetup, approve } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const register = async (chatId: number, isAdmin: boolean, approved: boolean) => {
    const user = await createUser(String(chatId));
    await setProvider(user.id, 'gemini');
    await completeSetup(user.id, encrypt('fake-key-for-stubbed-tests'), isAdmin);
    if (approved && !isAdmin) {
      await approve(user.id);
    }
    return user.id;
  };
  ownerId = await register(OWNER_TG, false, true);
  const otherId = await register(OTHER_TG, false, true);
  await register(PENDING_TG, false, false);
  await register(ADMIN_TG, true, true);

  const { logExpense } = await import('../expense/service');
  const { logIncome } = await import('../income/service');
  const expense = (userId: string, amount: number, merchant: string, categoryHint: any, spentAt: Date) =>
    logExpense(userId, { amount, merchant, categoryHint, spentAt, source: 'text' });

  await expense(ownerId, 12, 'Ya Kun', 'Food', new Date(2026, 8, 2, 9));
  await expense(ownerId, 30, 'NTUC FairPrice', 'Groceries', new Date(2026, 8, 5, 18));
  await expense(ownerId, 8, 'Ya Kun', 'Food', new Date(2026, 8, 10, 9));
  await expense(ownerId, 50, 'Grab', 'Transport', new Date(2026, 7, 28, 20)); // August
  await expense(otherId, 999, 'Somebody else', 'Shopping', new Date(2026, 8, 3, 12));
  await logIncome(ownerId, { amount: 200, source: 'Salary', receivedAt: new Date(2026, 8, 1, 10) });
});

/** initData as Telegram would sign it for this bot. */
function signInitData(telegramUserId: number, authDate: Date, token = BOT_TOKEN): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(authDate.getTime() / 1000)),
    query_id: 'AAE-test',
    user: JSON.stringify({ id: telegramUserId, first_name: 'Test' }),
  });
  const fields: string[] = [];
  params.forEach((value, key) => fields.push(`${key}=${value}`));
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(fields.sort().join('\n')).digest('hex'));
  return params.toString();
}

async function webApp(web: Record<string, unknown> = {}) {
  const { createWebhookApp } = await import('./index');
  return createWebhookApp(null, { web: { botToken: BOT_TOKEN, sessionSecret: SESSION_SECRET, now: () => NOW, ...web } });
}

async function login(telegramUserId: number): Promise<string> {
  const app = await webApp();
  const res = await app.request('/api/web/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ initData: signInitData(telegramUserId, NOW) }),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { token: string }).token;
}

async function get(pathAndQuery: string, token: string) {
  const app = await webApp();
  const res = await app.request(pathAndQuery, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as any };
}

// --- initData and session tokens --------------------------------------------------

test('verifyInitData accepts Telegram-signed data and nothing else', async () => {
  const { verifyInitData } = await import('../web/init-data');
  const good = signInitData(OWNER_TG, NOW);

  assert.deepEqual(verifyInitData(good, BOT_TOKEN, NOW)?.telegramUserId, String(OWNER_TG));
  assert.equal(verifyInitData(signInitData(OWNER_TG, NOW, '999:another-bot'), BOT_TOKEN, NOW), null, 'another bot');
  assert.equal(verifyInitData(good.replace(String(OWNER_TG), String(OTHER_TG)), BOT_TOKEN, NOW), null, 'edited user');
  assert.equal(verifyInitData(good.replace(/hash=[^&]+/, ''), BOT_TOKEN, NOW), null, 'no hash');
  assert.equal(verifyInitData('', BOT_TOKEN, NOW), null);

  const old = signInitData(OWNER_TG, new Date(NOW.getTime() - 25 * 60 * 60 * 1000));
  assert.equal(verifyInitData(old, BOT_TOKEN, NOW), null, 'older than a day');
});

test('session tokens expire and refuse a forged signature', async () => {
  const { createSessionToken, verifySessionToken } = await import('../web/session');
  const { token } = createSessionToken('user-1', SESSION_SECRET, NOW);

  assert.equal(verifySessionToken(token, SESSION_SECRET, NOW), 'user-1');
  assert.equal(verifySessionToken(token, 'some-other-secret-of-sufficient-length', NOW), null);
  assert.equal(verifySessionToken(token, SESSION_SECRET, new Date(NOW.getTime() + 61 * 60 * 1000)), null);
  const [, signature] = token.split('.');
  const forged = `${Buffer.from(JSON.stringify({ sub: 'user-2', exp: NOW.getTime() + 1e9 })).toString('base64url')}.${signature}`;
  assert.equal(verifySessionToken(forged, SESSION_SECRET, NOW), null);
});

// --- routes -----------------------------------------------------------------------

test('every /api/web route answers 503 when a secret is missing', async () => {
  for (const web of [{ botToken: undefined }, { sessionSecret: undefined }]) {
    const app = await webApp(web);
    assert.equal((await app.request('/api/web/session', { method: 'POST', body: '{}' })).status, 503);
    assert.equal((await app.request('/api/web/summary')).status, 503);
  }
});

test('POST /api/web/session issues a token only to an approved user with valid initData', async () => {
  const app = await webApp();
  const post = (initData: unknown) =>
    app.request('/api/web/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData }),
    });

  const ok = await post(signInitData(OWNER_TG, NOW));
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as any;
  assert.equal(body.user.id, ownerId);
  assert.equal(body.user.isAdmin, false);
  assert.equal(typeof body.token, 'string');

  assert.equal((await post(signInitData(OWNER_TG, NOW, '999:another-bot'))).status, 401);
  assert.equal((await post(42)).status, 401);
  assert.equal((await post(signInitData(PENDING_TG, NOW))).status, 403, 'awaiting approval');
  assert.equal((await post(signInitData(719999, NOW))).status, 403, 'never registered');
});

test('data routes need a valid bearer token', async () => {
  const app = await webApp();
  assert.equal((await app.request('/api/web/summary')).status, 401);
  assert.equal((await get('/api/web/summary', 'not-a-token')).status, 401);
});

test("GET /api/web/summary totals one user's month, by category, with income", async () => {
  const token = await login(OWNER_TG);
  const { status, body } = await get('/api/web/summary', token);

  assert.equal(status, 200);
  assert.equal(body.month, '2026-09');
  assert.equal(body.spentSgd, 5000, "September only, and not the other user's S$999");
  assert.equal(body.count, 3);
  assert.equal(body.previousMonthSpentSgd, 5000);
  assert.equal(body.incomeSgd, 20000);
  assert.equal(body.savingsRate, 0.75);
  assert.deepEqual(body.byCategory, [
    { category: 'Groceries', spentSgd: 3000, count: 1 },
    { category: 'Food', spentSgd: 2000, count: 2 },
  ]);

  const august = await get('/api/web/summary?month=2026-08', token);
  assert.equal(august.body.spentSgd, 5000);
  assert.equal(august.body.savingsRate, null, 'no income that month');
  assert.equal((await get('/api/web/summary?month=2026-13', token)).status, 400);
});

test('GET /api/web/transactions pages newest spent first and filters', async () => {
  const token = await login(OWNER_TG);

  const first = await get('/api/web/transactions?limit=2', token);
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.body.transactions.map((row: any) => [row.merchant, row.amountSgd]),
    [
      ['Ya Kun', 800],
      ['NTUC FairPrice', 3000],
    ],
  );
  assert.equal(first.body.transactions[0].currency, 'SGD');
  assert.ok(first.body.nextCursor);

  const second = await get(`/api/web/transactions?limit=2&cursor=${first.body.nextCursor}`, token);
  assert.deepEqual(
    second.body.transactions.map((row: any) => row.merchant),
    ['Ya Kun', 'Grab'],
  );
  assert.equal(second.body.nextCursor, null);

  const food = await get('/api/web/transactions?category=Food', token);
  assert.equal(food.body.transactions.length, 2);
  const search = await get('/api/web/transactions?q=ntuc', token);
  assert.deepEqual(search.body.transactions.map((row: any) => row.merchant), ['NTUC FairPrice']);
  const window = await get('/api/web/transactions?from=2026-09-02&to=2026-09-05', token);
  assert.deepEqual(window.body.transactions.map((row: any) => row.amountSgd), [3000, 1200], 'to is inclusive');

  assert.equal((await get('/api/web/transactions?category=Snacks', token)).status, 400);
  assert.equal((await get('/api/web/transactions?cursor=garbage', token)).status, 400);
  assert.equal((await get('/api/web/transactions?from=2026-02-31', token)).status, 400);
});

test("GET /api/web/transactions never shows another user's rows", async () => {
  const token = await login(OTHER_TG);
  const { body } = await get('/api/web/transactions', token);
  assert.deepEqual(body.transactions.map((row: any) => row.merchant), ['Somebody else']);
});

test('GET /api/web/admin/users is for admins, and never exposes keys', async () => {
  assert.equal((await get('/api/web/admin/users', await login(OWNER_TG))).status, 403);

  const { status, body } = await get('/api/web/admin/users', await login(ADMIN_TG));
  assert.equal(status, 200);
  assert.equal(body.users.length, 4);
  assert.ok(body.users.some((user: any) => user.status === 'pending_approval'));
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('webhook'), 'no webhook key');
  assert.ok(!serialized.toLowerCase().includes('encrypted'), 'no LLM key');
});

test('a session stops working once its user is rejected', async () => {
  const { createUser, setProvider, completeSetup, reject } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const user = await createUser('710005');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-stubbed-tests'), true);
  const token = await login(710005);
  assert.equal((await get('/api/web/me', token)).status, 200);

  await reject(user.id);
  assert.equal((await get('/api/web/me', token)).status, 403);
});
