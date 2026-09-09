import test from 'node:test';
import assert from 'node:assert/strict';

const VALID_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 64 hex chars
const BASE_ENV = {
  DATABASE_URL: './data/test-env-config.db',
  GOOGLE_API_KEY: 'unused-in-this-file',
  ENCRYPTION_KEY: VALID_KEY,
};

function loadConfigWith(env: Record<string, string | undefined>): unknown {
  const originalEnv = { ...process.env };
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  Object.assign(process.env, env);

  try {
    delete require.cache[require.resolve('./env')];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./env').config;
  } finally {
    Object.keys(process.env).forEach((key) => delete process.env[key]);
    Object.assign(process.env, originalEnv);
  }
}

test('loadConfig accepts a valid 64-character hex ENCRYPTION_KEY', () => {
  const config = loadConfigWith(BASE_ENV) as { ENCRYPTION_KEY: string };
  assert.equal(config.ENCRYPTION_KEY, VALID_KEY);
});

test('loadConfig rejects an ENCRYPTION_KEY that is not 64 hex characters', () => {
  assert.throws(() => loadConfigWith({ ...BASE_ENV, ENCRYPTION_KEY: 'too-short' }));
});

test('loadConfig succeeds without ADMIN_CHAT_ID when TELEGRAM_BOT_TOKEN is unset', () => {
  const config = loadConfigWith(BASE_ENV) as { ADMIN_CHAT_ID?: string };
  assert.equal(config.ADMIN_CHAT_ID, undefined);
});

test('loadConfig rejects a missing ADMIN_CHAT_ID when TELEGRAM_BOT_TOKEN is set', () => {
  assert.throws(() => loadConfigWith({ ...BASE_ENV, TELEGRAM_BOT_TOKEN: 'fake-token' }));
});

test('loadConfig accepts ADMIN_CHAT_ID when TELEGRAM_BOT_TOKEN is set', () => {
  const config = loadConfigWith({ ...BASE_ENV, TELEGRAM_BOT_TOKEN: 'fake-token', ADMIN_CHAT_ID: '12345' }) as {
    ADMIN_CHAT_ID?: string;
  };
  assert.equal(config.ADMIN_CHAT_ID, '12345');
});
