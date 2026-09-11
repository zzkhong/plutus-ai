/**
 * Environment configuration loading and validation.
 *
 * There is deliberately no global LLM key or webhook secret here: every user
 * brings their own provider key via /setup (stored encrypted on their users
 * row) and gets their own webhook_api_key, so ENCRYPTION_KEY is the only
 * secret every deployment needs.
 */

import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables
dotenv.config();

const URL_SCHEME = /^(file|libsql|https?|wss?):/i;

/**
 * DATABASE_URL accepts a libSQL URL — `libsql://…` for Turso, `file:…` for a
 * local SQLite file — or a bare path, which is treated as a local file so
 * existing values like `./data/pluto.db` keep working.
 */
export function normalizeDatabaseUrl(value: string): string {
  if (URL_SCHEME.test(value)) {
    return value;
  }
  return `file:${value.replace(/\\/g, '/')}`;
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// An empty value in .env (e.g. `CRON_SECRET=`) means "not set", not "set to ''".
function optional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((value) => (value === '' ? undefined : value), schema.optional());
}

// The alphabet Telegram allows for setWebhook's secret_token.
const TELEGRAM_SECRET_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

// Define schema for environment variables
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DATABASE_URL: z.string().default('file:./data/pluto.db').transform(normalizeDatabaseUrl),
    DATABASE_AUTH_TOKEN: optional(z.string()),
    TELEGRAM_BOT_TOKEN: optional(z.string()),
    TELEGRAM_WEBHOOK_SECRET: optional(
      z
        .string()
        .regex(TELEGRAM_SECRET_PATTERN, 'TELEGRAM_WEBHOOK_SECRET may only use A-Z, a-z, 0-9, _ and - (1-256 characters)'),
    ),
    ADMIN_CHAT_ID: optional(z.string()),
    CRON_SECRET: optional(z.string().min(16, 'CRON_SECRET should be at least 16 characters')),
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, 'ENCRYPTION_KEY must be a 64-character hex string (32 bytes) for AES-256-GCM'),
    APP_TIMEZONE: z
      .string()
      .default('Asia/Singapore')
      .refine(isValidTimeZone, 'APP_TIMEZONE must be an IANA time zone such as Asia/Singapore'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    PORT: z.string().default('3000'),
  })
  .superRefine((val, ctx) => {
    if (val.TELEGRAM_BOT_TOKEN && !val.ADMIN_CHAT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ADMIN_CHAT_ID'],
        message:
          'ADMIN_CHAT_ID is required when TELEGRAM_BOT_TOKEN is set — without a designated admin, no user (including the first) can be approved.',
      });
    }
    if (val.DATABASE_URL.startsWith('libsql://') && !val.DATABASE_AUTH_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_AUTH_TOKEN'],
        message: 'DATABASE_AUTH_TOKEN is required for a Turso (libsql://) DATABASE_URL.',
      });
    }
  });

// Type for the validated config
export type Config = z.infer<typeof envSchema>;

// Validate and export config
function loadConfig(): Config {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('Environment validation failed:', error.flatten());
      throw new Error('Invalid environment configuration', { cause: error });
    }
    throw error;
  }
}

export const config = loadConfig();

// Vercel reserves TZ (its functions always run in UTC), so the app pins its
// own zone here — before anything computes "today", a month boundary, or a
// recurring charge's day of the month.
process.env.TZ = config.APP_TIMEZONE;
