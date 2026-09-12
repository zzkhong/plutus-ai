import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-chat-sequence.db';

const testDbPath = path.resolve('./data/test-chat-sequence.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  await runMigrations();
});

function update(chatId: number, updateId: number) {
  return { chat: { id: chatId }, update: { update_id: updateId } } as any;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function rowsFor(chatId: string): Promise<number> {
  const { db, chat_updates } = await import('../../db');
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(chat_updates).where(eq(chat_updates.chat_id, chatId))).length;
}

test("a chat's later update waits for its earlier one, while another chat's goes ahead", async () => {
  const { createChatSequencer } = await import('./sequence');
  const sequencer = createChatSequencer({ pollMs: 10 });
  const order: string[] = [];
  let finishFirst!: () => void;
  const firstMayFinish = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  let firstStarted!: () => void;
  const firstIsRunning = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });

  const first = sequencer(update(1, 100), async () => {
    order.push('chat 1, first');
    firstStarted();
    await firstMayFinish;
    order.push('chat 1, first done');
  });
  // The first update is registered and running before the second arrives, as on a real chat.
  await firstIsRunning;
  const second = sequencer(update(1, 101), async () => {
    order.push('chat 1, second');
  });
  await sequencer(update(2, 102), async () => {
    order.push('chat 2');
  });
  await pause(50);

  assert.deepEqual(order, ['chat 1, first', 'chat 2'], 'the second waits; the other chat does not');

  finishFirst();
  await Promise.all([first, second]);

  assert.deepEqual(order, ['chat 1, first', 'chat 2', 'chat 1, first done', 'chat 1, second']);
  assert.equal(await rowsFor('1'), 0, 'finished updates are cleared');
});

test('an update left behind by a crashed instance does not hold its chat up', async () => {
  const { createChatSequencer } = await import('./sequence');
  const { db, chat_updates } = await import('../../db');
  await db.insert(chat_updates).values({ update_id: 200, chat_id: '3', started_at: Date.now() - 10 * 60_000 });

  let ran = false;
  await createChatSequencer({ pollMs: 10, staleMs: 60_000 })(update(3, 201), async () => {
    ran = true;
  });

  assert.equal(ran, true);
  assert.equal(await rowsFor('3'), 0, 'and the stale registration is cleared');
});

test('an update stops waiting after the longest wait, and goes ahead', async () => {
  const { createChatSequencer } = await import('./sequence');
  const { db, chat_updates } = await import('../../db');
  await db.insert(chat_updates).values({ update_id: 300, chat_id: '4', started_at: Date.now() });

  const started = Date.now();
  let ran = false;
  await createChatSequencer({ pollMs: 10, maxWaitMs: 100 })(update(4, 301), async () => {
    ran = true;
  });

  assert.equal(ran, true);
  assert.ok(Date.now() - started >= 100);
});

test('an update whose handler fails is still cleared, so the next one runs', async () => {
  const { createChatSequencer } = await import('./sequence');
  const sequencer = createChatSequencer({ pollMs: 10, maxWaitMs: 1_000 });

  await assert.rejects(
    sequencer(update(5, 400), async () => {
      throw new Error('handler failed');
    }),
  );
  assert.equal(await rowsFor('5'), 0, 'the failed update no longer holds the chat');

  let ran = false;
  await sequencer(update(5, 401), async () => {
    ran = true;
  });

  assert.equal(ran, true);
  assert.equal(await rowsFor('5'), 0);
});

test('an update from no chat at all runs straight away', async () => {
  const { createChatSequencer } = await import('./sequence');
  let ran = false;
  await createChatSequencer()({ update: { update_id: 500 } } as any, async () => {
    ran = true;
  });
  assert.equal(ran, true);
});
