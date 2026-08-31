import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-document-handler.db';

const testDbPath = path.resolve('./data/test-document-handler.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  runMigrations();
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
    const reply = await handleDocumentMessage(Buffer.from('not a pdf'), 'image/png');

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
    const reply = await handleDocumentMessage(Buffer.from('%PDF-1.4 fake'), 'application/pdf');

    assert.match(reply, /couldn't read/i);
  } finally {
    global.fetch = originalFetch;
  }
});
