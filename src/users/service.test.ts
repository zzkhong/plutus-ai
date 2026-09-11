import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-users-service.db';

const testDbPath = path.resolve('./data/test-users-service.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  await runMigrations();
});

test('createUser creates an onboarding row with no provider or admin flag', async () => {
  const { createUser } = await import('./service');
  const user = await createUser('chat-1');

  assert.equal(user.telegram_chat_id, 'chat-1');
  assert.equal(user.status, 'onboarding');
  assert.equal(user.is_admin, false);
  assert.equal(user.llm_provider, null);
  assert.equal(user.llm_api_key_encrypted, null);
  assert.equal(user.webhook_api_key, null);
});

test('findByChatId returns null when no user exists for that chat', async () => {
  const { findByChatId } = await import('./service');
  const result = await findByChatId('nonexistent-chat');
  assert.equal(result, null);
});

test('findByChatId returns the created user', async () => {
  const { createUser, findByChatId } = await import('./service');
  await createUser('chat-2');

  const found = await findByChatId('chat-2');
  assert.ok(found);
  assert.equal(found!.telegram_chat_id, 'chat-2');
});

test('setProvider records the chosen provider and (re)sets status to onboarding', async () => {
  const { createUser, setProvider, approve } = await import('./service');
  const user = await createUser('chat-3');
  await approve(user.id); // simulate an already-approved user restarting setup

  const updated = await setProvider(user.id, 'gemini');
  assert.equal(updated.llm_provider, 'gemini');
  assert.equal(updated.status, 'onboarding');
});

test('completeSetup for a first-time non-admin user goes to pending_approval and generates a webhook key', async () => {
  const { createUser, setProvider, completeSetup } = await import('./service');
  const user = await createUser('chat-4');
  await setProvider(user.id, 'gemini');

  const completed = await completeSetup(user.id, 'encrypted-key-value', false);
  assert.equal(completed.status, 'pending_approval');
  assert.equal(completed.is_admin, false);
  assert.equal(completed.llm_api_key_encrypted, 'encrypted-key-value');
  assert.ok(completed.webhook_api_key);
});

test('completeSetup for the admin chat auto-approves', async () => {
  const { createUser, setProvider, completeSetup } = await import('./service');
  const user = await createUser('chat-5-admin');
  await setProvider(user.id, 'gemini');

  const completed = await completeSetup(user.id, 'encrypted-key-value', true);
  assert.equal(completed.status, 'approved');
  assert.equal(completed.is_admin, true);
});

test('completeSetup on an already-completed user (key rotation) stays approved and reuses the webhook key', async () => {
  const { createUser, setProvider, completeSetup, approve } = await import('./service');
  const user = await createUser('chat-6');
  await setProvider(user.id, 'gemini');
  const firstCompletion = await completeSetup(user.id, 'first-key', false);
  await approve(user.id); // admin approves the pending user

  await setProvider(user.id, 'gemini'); // re-running /setup
  const rotated = await completeSetup(user.id, 'second-key', false);

  assert.equal(rotated.status, 'approved'); // skipped pending_approval on rotation
  assert.equal(rotated.llm_api_key_encrypted, 'second-key');
  assert.equal(rotated.webhook_api_key, firstCompletion.webhook_api_key);
});

test('approve sets status to approved', async () => {
  const { createUser, approve } = await import('./service');
  const user = await createUser('chat-7');
  const approved = await approve(user.id);
  assert.equal(approved.status, 'approved');
});

test('reject deletes the user row', async () => {
  const { createUser, reject, findByChatId } = await import('./service');
  await createUser('chat-8');
  const user = await findByChatId('chat-8');
  await reject(user!.id);

  const afterReject = await findByChatId('chat-8');
  assert.equal(afterReject, null);
});

test('reject also deletes everything the user owns, without relying on foreign keys', async () => {
  const { createUser, reject } = await import('./service');
  const { db } = await import('../db');
  const { transactions, budgets, holdings, recurring_transactions, split_sessions } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const { randomUUID } = await import('node:crypto');

  const user = await createUser('chat-reject-owned');
  const now = Date.now();
  await db.insert(transactions).values({
    id: randomUUID(), user_id: user.id, amount: 100, currency: 'SGD', amount_sgd: 100, merchant: 'x',
    category: 'Food', source: 'text', card_name: 'x', created_at: now, updated_at: now,
  });
  await db.insert(budgets).values({
    id: randomUUID(), user_id: user.id, category: 'Food', amount: 1000, currency: 'SGD', amount_sgd: 1000,
    period: 'monthly', created_at: now, updated_at: now,
  });
  await db.insert(holdings).values({
    id: randomUUID(), user_id: user.id, symbol: 'BTC', name: 'Bitcoin', asset_class: 'crypto', quantity: 1,
    currency: 'USD', market: 'crypto', broker: null, created_at: now, updated_at: now,
  });
  await db.insert(recurring_transactions).values({
    id: randomUUID(), user_id: user.id, amount: 100, currency: 'SGD', merchant: 'x', category: 'Bills',
    day_of_month: 1, created_at: now, updated_at: now,
  });
  await db.insert(split_sessions).values({ chat_id: 'chat-reject-owned', state: '{"stage":"awaiting_photo"}', updated_at: now });

  await reject(user.id);

  // Foreign keys are not enforced here (or on Turso), so these only pass
  // because reject() deletes the children itself.
  assert.equal((await db.select().from(transactions).where(eq(transactions.user_id, user.id))).length, 0);
  assert.equal((await db.select().from(budgets).where(eq(budgets.user_id, user.id))).length, 0);
  assert.equal((await db.select().from(holdings).where(eq(holdings.user_id, user.id))).length, 0);
  assert.equal(
    (await db.select().from(recurring_transactions).where(eq(recurring_transactions.user_id, user.id))).length,
    0,
  );
  assert.equal((await db.select().from(split_sessions).where(eq(split_sessions.chat_id, 'chat-reject-owned'))).length, 0);
});

test('findByWebhookKey returns the matching user', async () => {
  const { createUser, setProvider, completeSetup, findByWebhookKey } = await import('./service');
  const user = await createUser('chat-9');
  await setProvider(user.id, 'gemini');
  const completed = await completeSetup(user.id, 'some-key', false);

  const found = await findByWebhookKey(completed.webhook_api_key!);
  assert.ok(found);
  assert.equal(found!.id, user.id);
});

test('findById returns null for a nonexistent id', async () => {
  const { findById } = await import('./service');
  const result = await findById('does-not-exist');
  assert.equal(result, null);
});

test('listApproved returns only approved users', async () => {
  const { createUser, approve, listApproved } = await import('./service');
  const approvedUser = await createUser('chat-10-approved');
  await approve(approvedUser.id);
  await createUser('chat-11-onboarding');

  const approvedList = await listApproved();
  assert.ok(approvedList.some((u) => u.telegram_chat_id === 'chat-10-approved'));
  assert.ok(!approvedList.some((u) => u.telegram_chat_id === 'chat-11-onboarding'));
});

test('restartOnboarding resets status to onboarding and clears the chosen provider', async () => {
  const { createUser, approve, setProvider, restartOnboarding } = await import('./service');
  const user = await createUser('chat-restart-onboarding');
  await setProvider(user.id, 'gemini');
  await approve(user.id);

  const restarted = await restartOnboarding(user.id);
  assert.equal(restarted.status, 'onboarding');
  assert.equal(restarted.llm_provider, null);
});
