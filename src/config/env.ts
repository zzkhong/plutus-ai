/**
 * Environment configuration loading and validation
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
    TELEGRAM_AUTHORIZED_CHAT_ID: z.string().optional(),
    ADMIN_CHAT_ID: z.string().optional(),
    GOOGLE_API_KEY: z
      .string()
      .min(1, 'GOOGLE_API_KEY is required — Pluto AI classifies every message with Gemini and has no rule-based fallback'),
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-f]{64}$/i, 'ENCRYPTION_KEY must be a 64-character hex string (32 bytes) for AES-256-GCM'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    PORT: z.string().default('3000'),
    WEBHOOK_API_KEY: z.string().optional(),
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
      throw new Error('Invalid environment configuration');
    }
    throw error;
  }
}

export const config = loadConfig();
