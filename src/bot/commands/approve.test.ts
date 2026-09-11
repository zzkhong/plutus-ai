import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-bot-approve.db';

const testDbPath = path.resolve('./data/test-bot-approve.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  await runMigrations();
});

test('handleApproveCommand refuses a non-admin caller', async () => {
  const { createUser } = await import('../../users/service');
  const nonAdmin = await createUser('chat-caller-1');

  const { handleApproveCommand } = await import('./approve');
  const result = await handleApproveCommand(nonAdmin, 'chat-target-1');

  assert.match(result.reply, /only the admin/i);
  assert.equal(result.notifyChatId, undefined);
});

test('handleApproveCommand asks for usage when no chat id is given', async () => {
  const { createUser, approve } = await import('../../users/service');
  const admin = await createUser('chat-admin-1');
  await approve(admin.id);

  const { handleApproveCommand } = await import('./approve');
  const result = await handleApproveCommand({ ...admin, is_admin: true }, '');

  assert.match(result.reply, /usage/i);
});

test('handleApproveCommand reports when no user exists for that chat', async () => {
  const { createUser } = await import('../../users/service');
  const admin = await createUser('chat-admin-2');

  const { handleApproveCommand } = await import('./approve');
  const result = await handleApproveCommand({ ...admin, is_admin: true }, 'nonexistent-chat');

  assert.match(result.reply, /no pending user/i);
});

test('handleApproveCommand approves a pending user and signals notifying them', async () => {
  const { createUser, setProvider, completeSetup, findByChatId } = await import('../../users/service');
  const { encrypt } = await import('../../users/crypto');
  const admin = await createUser('chat-admin-3');
  const pending = await createUser('chat-pending-1');
  await setProvider(pending.id, 'gemini');
  await completeSetup(pending.id, encrypt('some-key'), false);

  const { handleApproveCommand } = await import('./approve');
  const result = await handleApproveCommand({ ...admin, is_admin: true }, 'chat-pending-1');

  assert.match(result.reply, /approved/i);
  assert.equal(result.notifyChatId, 'chat-pending-1');
  assert.ok(result.notifyMessage);

  const updated = await findByChatId('chat-pending-1');
  assert.equal(updated!.status, 'approved');
});

test('handleRejectCommand refuses a non-admin caller', async () => {
  const { createUser } = await import('../../users/service');
  const nonAdmin = await createUser('chat-caller-2');

  const { handleRejectCommand } = await import('./approve');
  const result = await handleRejectCommand(nonAdmin, 'chat-target-2');

  assert.match(result.reply, /only the admin/i);
});

test('handleRejectCommand deletes the pending user and signals notifying them', async () => {
  const { createUser, setProvider, completeSetup, findByChatId } = await import('../../users/service');
  const { encrypt } = await import('../../users/crypto');
  const admin = await createUser('chat-admin-4');
  const pending = await createUser('chat-pending-2');
  await setProvider(pending.id, 'gemini');
  await completeSetup(pending.id, encrypt('some-key'), false);

  const { handleRejectCommand } = await import('./approve');
  const result = await handleRejectCommand({ ...admin, is_admin: true }, 'chat-pending-2');

  assert.match(result.reply, /rejected/i);
  assert.equal(result.notifyChatId, 'chat-pending-2');

  const deleted = await findByChatId('chat-pending-2');
  assert.equal(deleted, null);
});
