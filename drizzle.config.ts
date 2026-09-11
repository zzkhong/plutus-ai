import type { Config } from 'drizzle-kit';
import * as dotenv from 'dotenv';

dotenv.config();

// Mirrors normalizeDatabaseUrl in src/config/env.ts. Inlined because
// importing src/config would demand ENCRYPTION_KEY just to generate SQL.
const rawUrl = process.env.DATABASE_URL || 'file:./data/pluto.db';
const url = /^(file|libsql|https?|wss?):/i.test(rawUrl) ? rawUrl : `file:${rawUrl}`;

export default {
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'turso',
  dbCredentials: {
    url,
    authToken: process.env.DATABASE_AUTH_TOKEN,
  },
} satisfies Config;
