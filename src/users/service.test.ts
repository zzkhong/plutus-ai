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
  runMigrations();
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
