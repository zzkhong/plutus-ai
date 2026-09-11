import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ExtractedReceipt, SplitResult } from './types';

// Must precede anything that reaches src/config or src/db — see CLAUDE.md.
process.env.DATABASE_URL = './data/test-split-state.db';

const testDbPath = path.resolve('./data/test-split-state.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

type StateModule = typeof import('./state');
let state: StateModule;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  await runMigrations();
  state = await import('./state');
});

function fakeReceipt(): ExtractedReceipt {
  return { merchant: 'Test Cafe', items: [{ name: 'Coffee', price: 4 }], taxAndTip: 0, total: 4, currency: 'SGD' };
}

function fakeResult(): SplitResult {
  const share = { label: 'You', itemSubtotal: 4, taxAndTipShare: 0, total: 4 };
  return { shares: [share], requesterShare: share };
}

test('startSplit puts a chat into awaiting_photo', async () => {
  await state.startSplit(1001);
  assert.deepEqual(await state.getSplitState(1001), { stage: 'awaiting_photo' });
});

test('getSplitState returns undefined for a chat with no active split', async () => {
  assert.equal(await state.getSplitState(999999), undefined);
});

test('setReceipt transitions to awaiting_instructions and stores the receipt', async () => {
  await state.startSplit(1002);
  await state.setReceipt(1002, fakeReceipt());

  const current = await state.getSplitState(1002);
  assert.equal(current?.stage, 'awaiting_instructions');
  assert.deepEqual(current?.receipt, fakeReceipt());
});

test('setReceipt rejects when there is no active split for that chat', async () => {
  await assert.rejects(() => state.setReceipt(1003, fakeReceipt()));
});

test('setPendingResult transitions to awaiting_log_confirmation and stores the result', async () => {
  await state.startSplit(1004);
  await state.setReceipt(1004, fakeReceipt());
  await state.setPendingResult(1004, fakeResult());

  const current = await state.getSplitState(1004);
  assert.equal(current?.stage, 'awaiting_log_confirmation');
  assert.deepEqual(current?.pendingResult, fakeResult());
  // receipt from the earlier stage is preserved, not dropped
  assert.deepEqual(current?.receipt, fakeReceipt());
});

test('setPendingResult rejects when there is no active split for that chat', async () => {
  await assert.rejects(() => state.setPendingResult(1005, fakeResult()));
});

test('clearSplit removes state and returns whether something was cleared', async () => {
  await state.startSplit(1006);
  assert.equal(await state.clearSplit(1006), true);
  assert.equal(await state.getSplitState(1006), undefined);
  assert.equal(await state.clearSplit(1006), false);
});

test('state for one chat never affects another chat', async () => {
  await state.startSplit(2001);
  await state.startSplit(2002);
  await state.setReceipt(2001, fakeReceipt());

  assert.equal((await state.getSplitState(2001))?.stage, 'awaiting_instructions');
  assert.equal((await state.getSplitState(2002))?.stage, 'awaiting_photo');
});

test('state is persisted in the database, not held in process memory', async () => {
  const { db } = await import('../db');
  const { split_sessions } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');

  await state.startSplit(3001);
  await state.setReceipt(3001, fakeReceipt());

  // What a different Vercel function instance would see: the row itself.
  const row = await db.select().from(split_sessions).where(eq(split_sessions.chat_id, '3001')).get();
  assert.ok(row, 'expected a split_sessions row');
  assert.equal(JSON.parse(row.state).stage, 'awaiting_instructions');
});

test('a split inside the expiry window is still active', async () => {
  await state.startSplit(4001);
  const almostExpired = Date.now() + state.SPLIT_SESSION_TTL_MS - 60_000;
  assert.equal((await state.getSplitState(4001, almostExpired))?.stage, 'awaiting_photo');
});

test('an abandoned split expires, so it stops capturing ordinary messages', async () => {
  await state.startSplit(4002);
  const afterExpiry = Date.now() + state.SPLIT_SESSION_TTL_MS + 60_000;

  assert.equal(await state.getSplitState(4002, afterExpiry), undefined);
  // Expired rows are deleted on read, so it stays gone.
  assert.equal(await state.getSplitState(4002), undefined);
  assert.equal(await state.clearSplit(4002), false);
});
