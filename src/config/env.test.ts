import test from 'node:test';
import assert from 'node:assert/strict';

const VALID_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; // 64 hex chars
const BASE_ENV = {
  DATABASE_URL: './data/test-env-config.db',
  ENCRYPTION_KEY: VALID_KEY,
};

function loadConfigWith(env: Record<string, string | undefined>): unknown {
  const originalEnv = { ...process.env };
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  Object.assign(process.env, env);

  try {
    delete require.cache[require.resolve('./env')];
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

function loadConfigAndTimezone(env: Record<string, string | undefined>): { config: unknown; tz: string | undefined } {
  const originalEnv = { ...process.env };
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  Object.assign(process.env, env);

  try {
    delete require.cache[require.resolve('./env')];
    const loaded = require('./env').config;
    return { config: loaded, tz: process.env.TZ };
  } finally {
    Object.keys(process.env).forEach((key) => delete process.env[key]);
    Object.assign(process.env, originalEnv);
  }
}

test('DATABASE_URL: a bare path is treated as a local SQLite file', () => {
  const config = loadConfigWith({ ...BASE_ENV, DATABASE_URL: './data/pluto.db' }) as { DATABASE_URL: string };
  assert.equal(config.DATABASE_URL, 'file:./data/pluto.db');
});

test('DATABASE_URL: a Turso URL passes through unchanged when it has an auth token', () => {
  const config = loadConfigWith({
    ...BASE_ENV,
    DATABASE_URL: 'libsql://plutus-me.aws-ap-northeast-1.turso.io',
    DATABASE_AUTH_TOKEN: 'token',
  }) as { DATABASE_URL: string };
  assert.equal(config.DATABASE_URL, 'libsql://plutus-me.aws-ap-northeast-1.turso.io');
});

test('loadConfig rejects a Turso URL without DATABASE_AUTH_TOKEN', () => {
  assert.throws(() => loadConfigWith({ ...BASE_ENV, DATABASE_URL: 'libsql://plutus-me.turso.io' }));
});

test('loadConfig treats an empty optional value in .env as unset', () => {
  const config = loadConfigWith({ ...BASE_ENV, TELEGRAM_WEBHOOK_SECRET: '', CRON_SECRET: '' }) as {
    TELEGRAM_WEBHOOK_SECRET?: string;
    CRON_SECRET?: string;
  };
  assert.equal(config.TELEGRAM_WEBHOOK_SECRET, undefined);
  assert.equal(config.CRON_SECRET, undefined);
});

test('loadConfig rejects a TELEGRAM_WEBHOOK_SECRET with characters Telegram does not allow', () => {
  assert.throws(() => loadConfigWith({ ...BASE_ENV, TELEGRAM_WEBHOOK_SECRET: 'has spaces!' }));
});

test('loadConfig pins process.env.TZ to APP_TIMEZONE, since Vercel reserves TZ', () => {
  assert.equal(loadConfigAndTimezone(BASE_ENV).tz, 'Asia/Singapore');
  assert.equal(loadConfigAndTimezone({ ...BASE_ENV, APP_TIMEZONE: 'Asia/Tokyo' }).tz, 'Asia/Tokyo');
});

test('loadConfig rejects an APP_TIMEZONE that is not an IANA zone', () => {
  assert.throws(() => loadConfigWith({ ...BASE_ENV, APP_TIMEZONE: 'Not/AZone' }));
});
