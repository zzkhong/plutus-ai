/**
 * Environment configuration loading and validation.
 *
 * There is deliberately no global LLM key or webhook secret here: every user
 * brings their own provider key via /setup (stored encrypted on their users
 * row) and gets their own webhook_api_key, so ENCRYPTION_KEY is the only
 * required secret.
 */

import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables
dotenv.config();

// Define schema for environment variables
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DATABASE_URL: z.string().default('./data/pluto.db'),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    ADMIN_CHAT_ID: z.string().optional(),
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, 'ENCRYPTION_KEY must be a 64-character hex string (32 bytes) for AES-256-GCM'),
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
