import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-digest.db';
process.env.TELEGRAM_AUTHORIZED_CHAT_ID = 'test-chat-id';

const testDbPath = path.resolve('./data/test-digest.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

const originalFetch = global.fetch;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  runMigrations();

  // No test in this file needs a real Gemini call — stub fetch so
  // generateSummaryLine (Task 5) deterministically falls back to its
  // rule-based line, keeping the suite network-free by default.
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;
});

after(() => {
  global.fetch = originalFetch;
});

test('settle degrades a rejected promise into a SectionResult error without throwing', async () => {
  const { settle } = await import('./aggregator');
  const result = await settle('testSection', Promise.reject(new Error('boom')));
  assert.deepEqual(result, { error: 'boom' });
});

test('settle passes a resolved value through unchanged', async () => {
  const { settle } = await import('./aggregator');
  const result = await settle('testSection', Promise.resolve({ ok: true }));
  assert.deepEqual(result, { ok: true });
});

test('collectDigestData returns real data for all live sources and a permanent portfolio stub', async () => {
  const { collectDigestData } = await import('./aggregator');
  const data = await collectDigestData();

  assert.ok('total' in (data.spending as object));
  assert.ok(Array.isArray(data.recurringFired));
  assert.ok(Array.isArray(data.budgetStatuses));
  assert.deepEqual(data.portfolio, { error: 'not yet implemented' });
});
