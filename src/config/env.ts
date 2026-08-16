/**
 * Environment configuration loading and validation
 */

import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables
dotenv.config();

// Define schema for environment variables
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().default('./data/pluto.db'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_AUTHORIZED_CHAT_ID: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.string().default('3000'),
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
