import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-bot-setup.db';
process.env.ADMIN_CHAT_ID = 'admin-chat-id';

const testDbPath = path.resolve('./data/test-bot-setup.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  await runMigrations();
});

function geminiRestResponse(text: string): Response {
  const body = JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

test('handleSetupCommand creates a new user and asks which provider', async () => {
  const { handleSetupCommand } = await import('./setup');
  const reply = await handleSetupCommand('chat-new-1');

  assert.match(reply, /which llm provider/i);

  const { findByChatId } = await import('../../users/service');
  const user = await findByChatId('chat-new-1');
  assert.ok(user);
  assert.equal(user!.status, 'onboarding');
});

test('handleSetupCommand restarts onboarding for an already-approved user', async () => {
  const { createUser, approve, setProvider, findByChatId } = await import('../../users/service');
  const user = await createUser('chat-restart-1');
  await setProvider(user.id, 'gemini');
  await approve(user.id);

  const { handleSetupCommand } = await import('./setup');
  await handleSetupCommand('chat-restart-1');

  const refreshed = await findByChatId('chat-restart-1');
  assert.equal(refreshed!.status, 'onboarding');
  assert.equal(refreshed!.llm_provider, null);
});

test('handleSetupTextMessage rejects an unsupported provider name', async () => {
  const { createUser } = await import('../../users/service');
  const user = await createUser('chat-provider-1');

  const { handleSetupTextMessage } = await import('./setup');
  const result = await handleSetupTextMessage(user, 'openai');

  assert.match(result.reply, /not available yet/i);
});

test('handleSetupTextMessage accepts gemini and asks for an API key', async () => {
  const { createUser, findByChatId } = await import('../../users/service');
  const user = await createUser('chat-provider-2');

  const { handleSetupTextMessage } = await import('./setup');
  const result = await handleSetupTextMessage(user, 'gemini');

  assert.match(result.reply, /api key/i);

  const updated = await findByChatId('chat-provider-2');
  assert.equal(updated!.llm_provider, 'gemini');
});

test('handleSetupTextMessage asks to resend when the key fails validation', async () => {
  const { createUser, setProvider, findByChatId } = await import('../../users/service');
  const user = await createUser('chat-key-fail');
  await setProvider(user.id, 'gemini');
  const refreshed = (await findByChatId('chat-key-fail'))!;

  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated invalid key rejection');
  }) as typeof fetch;

  try {
    const { handleSetupTextMessage } = await import('./setup');
    const result = await handleSetupTextMessage(refreshed, 'bad-key');
    assert.match(result.reply, /didn't work|resend/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleSetupTextMessage on success for a non-admin chat goes to pending_approval and signals an admin notification', async () => {
  const { createUser, setProvider, findByChatId } = await import('../../users/service');
  const user = await createUser('chat-non-admin');
  await setProvider(user.id, 'gemini');
  const refreshed = (await findByChatId('chat-non-admin'))!;

  const originalFetch = global.fetch;
  global.fetch = (async () => geminiRestResponse('OK')) as typeof fetch;

  try {
    const { handleSetupTextMessage } = await import('./setup');
    const result = await handleSetupTextMessage(refreshed, 'a-valid-looking-key');

    assert.match(result.reply, /admin needs to approve/i);
    assert.equal(result.notifyAdminForChatId, 'chat-non-admin');

    const stored = await findByChatId('chat-non-admin');
    assert.equal(stored!.status, 'pending_approval');
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleSetupTextMessage on success for the ADMIN_CHAT_ID auto-approves without notifying anyone', async () => {
  const { createUser, setProvider, findByChatId } = await import('../../users/service');
  const user = await createUser('admin-chat-id');
  await setProvider(user.id, 'gemini');
  const refreshed = (await findByChatId('admin-chat-id'))!;

  const originalFetch = global.fetch;
  global.fetch = (async () => geminiRestResponse('OK')) as typeof fetch;

  try {
    const { handleSetupTextMessage } = await import('./setup');
    const result = await handleSetupTextMessage(refreshed, 'a-valid-looking-key');

    assert.match(result.reply, /auto-approved/i);
    assert.equal(result.notifyAdminForChatId, undefined);

    const stored = await findByChatId('admin-chat-id');
    assert.equal(stored!.status, 'approved');
    assert.equal(stored!.is_admin, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleSetupTextMessage on a key rotation (already approved) re-approves directly without pending_approval', async () => {
  const { createUser, setProvider, completeSetup, approve, findByChatId, restartOnboarding } = await import(
    '../../users/service'
  );
  const { encrypt } = await import('../../users/crypto');
  const user = await createUser('chat-rotate-1');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('first-key'), false);
  await approve(user.id);

  await restartOnboarding(user.id);
  await setProvider(user.id, 'gemini');
  const refreshed = (await findByChatId('chat-rotate-1'))!;

  const originalFetch = global.fetch;
  global.fetch = (async () => geminiRestResponse('OK')) as typeof fetch;

  try {
    const { handleSetupTextMessage } = await import('./setup');
    const result = await handleSetupTextMessage(refreshed, 'second-key');

    assert.match(result.reply, /updated/i);
    assert.equal(result.notifyAdminForChatId, undefined);

    const stored = await findByChatId('chat-rotate-1');
    assert.equal(stored!.status, 'approved');
  } finally {
    global.fetch = originalFetch;
  }
});

test('classifyKeyFailure blames the key only when Google says it is the key', async () => {
  const { classifyKeyFailure } = await import('./setup');

  assert.equal(classifyKeyFailure('[400 Bad Request] API key not valid. Please pass a valid API key.'), 'invalid');
  assert.equal(classifyKeyFailure('[403 Forbidden] PERMISSION_DENIED'), 'invalid');
  assert.equal(classifyKeyFailure('[429 Too Many Requests] Resource has been exhausted (e.g. check quota).'), 'rate_limited');
  assert.equal(classifyKeyFailure('[404 Not Found] models/gemini-x is not found for API version v1beta'), 'unavailable');
  assert.equal(classifyKeyFailure('Gemini call timed out after 10000ms'), 'unavailable');
});

test('handleSetupTextMessage says whether Google rejected the key or only rate-limited it', async () => {
  const { createUser, setProvider, findByChatId } = await import('../../users/service');
  const { handleSetupTextMessage } = await import('./setup');
  const created = await createUser('chat-key-failures');
  await setProvider(created.id, 'gemini');
  const user = (await findByChatId('chat-key-failures'))!;
  const googleError = (status: number, statusText: string, message: string) =>
    (async () =>
      new Response(JSON.stringify({ error: { code: status, message } }), {
        status,
        statusText,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

  const originalFetch = global.fetch;
  try {
    global.fetch = googleError(400, 'Bad Request', 'API key not valid. Please pass a valid API key.');
    assert.match((await handleSetupTextMessage(user, 'bad-key')).reply, /Google rejected it/);

    global.fetch = googleError(429, 'Too Many Requests', 'Resource has been exhausted (e.g. check quota).');
    assert.match((await handleSetupTextMessage(user, 'busy-key')).reply, /over its rate limit/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('asking for the key explains that messages are read with Gemini', async () => {
  const { createUser } = await import('../../users/service');
  const { handleSetupTextMessage } = await import('./setup');
  const user = await createUser('chat-key-privacy');

  const { reply } = await handleSetupTextMessage(user, 'gemini');

  assert.match(reply, /free tier, Google may use what's sent to improve its products/);
});
