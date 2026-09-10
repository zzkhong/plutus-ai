import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-document-handler.db';

const testDbPath = path.resolve('./data/test-document-handler.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

let userId: string;

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  runMigrations();
  const { createUser, setProvider, completeSetup } = await import('../../users/service');
  const { encrypt } = await import('../../users/crypto');
  const user = await createUser('test-document-handler-chat');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-tests'), true);
  userId = user.id;
});

test('handleDocumentMessage rejects a non-PDF file without calling Gemini', async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error('should not be called');
  }) as typeof fetch;

  try {
    const { handleDocumentMessage } = await import('./document');
    const reply = await handleDocumentMessage(userId, Buffer.from('not a pdf'), 'image/png');

    assert.match(reply, /PDF/i);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleDocumentMessage returns a friendly message when statement parsing fails', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { handleDocumentMessage } = await import('./document');
    const reply = await handleDocumentMessage(userId, Buffer.from('%PDF-1.4 fake'), 'application/pdf');

    assert.match(reply, /couldn't read/i);
  } finally {
    global.fetch = originalFetch;
  }
});
