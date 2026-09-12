import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-bot-auth.db';

const testDbPath = path.resolve('./data/test-bot-auth.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  await runMigrations();
});

function fakeCtx(chatId: number, text?: string) {
  const replies: string[] = [];
  const ctx: any = {
    chat: { id: chatId },
    message: text !== undefined ? { text } : undefined,
    reply: async (msg: string) => {
      replies.push(msg);
    },
  };
  return { ctx, replies };
}

test('authMiddleware blocks an unregistered chat sending a non-setup message', async () => {
  const { authMiddleware } = await import('./auth');
  const { ctx, replies } = fakeCtx(9001, 'Spent $4.50 at Ya Kun');
  let nextCalled = false;

  await authMiddleware(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.match(replies[0], /run \/setup/i);
  assert.equal(ctx.user, undefined);
});

test('authMiddleware lets an unregistered chat through for /setup', async () => {
  const { authMiddleware } = await import('./auth');
  const { ctx } = fakeCtx(9002, '/setup');
  let nextCalled = false;

  await authMiddleware(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});

test('authMiddleware lets an unregistered chat through for /help', async () => {
  const { authMiddleware } = await import('./auth');
  const { ctx } = fakeCtx(9003, '/help');
  let nextCalled = false;

  await authMiddleware(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
});

test('authMiddleware blocks a pending-approval user sending a non-setup message', async () => {
  const { createUser, setProvider, completeSetup } = await import('../../users/service');
  const { encrypt } = await import('../../users/crypto');
  const user = await createUser('9004');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key'), false); // isAdmin=false -> pending_approval

  const { authMiddleware } = await import('./auth');
  const { ctx, replies } = fakeCtx(9004, 'How much did I spend?');
  let nextCalled = false;

  await authMiddleware(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.match(replies[0], /admin approval/i);
});

test('authMiddleware attaches the user and calls next for an onboarding chat', async () => {
  const { createUser } = await import('../../users/service');
  await createUser('9005');

  const { authMiddleware } = await import('./auth');
  const { ctx } = fakeCtx(9005, 'gemini');
  let nextCalled = false;

  await authMiddleware(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.ok(ctx.user);
  assert.equal(ctx.user.status, 'onboarding');
});

test('authMiddleware attaches the user and calls next for an approved chat', async () => {
  const { createUser, approve } = await import('../../users/service');
  const user = await createUser('9006');
  await approve(user.id);

  const { authMiddleware } = await import('./auth');
  const { ctx } = fakeCtx(9006, 'Spent $4.50 at Ya Kun');
  let nextCalled = false;

  await authMiddleware(ctx, async () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(ctx.user!.status, 'approved');
});

test('authMiddleware lets a chat part-way through /setup send only setup replies, /setup and /help', async () => {
  const { createUser } = await import('../../users/service');
  await createUser('9007');
  const { authMiddleware } = await import('./auth');

  const cases: Array<[string | undefined, boolean]> = [
    ['gemini', true],
    ['/setup', true],
    ['/help', true],
    ['/today', false],
    [undefined, false], // a photo, voice note, file or button press
  ];
  for (const [text, allowed] of cases) {
    const { ctx, replies } = fakeCtx(9007, text);
    let nextCalled = false;
    await authMiddleware(ctx, async () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, allowed, text ?? 'a message without text');
    if (!allowed) {
      assert.match(replies[0], /Finish setting up first: reply "gemini"/);
    }
  }
});
