/**
 * The single database handle.
 *
 * libSQL reaches a local SQLite file (`file:` URLs — local development and
 * tests) and Turso (`libsql://` URLs — production on Vercel) through the
 * same client, so every query in the app runs unchanged against either.
 *
 * Creating the client is cheap and lazy — nothing goes over the network
 * until the first query — which matters on Vercel, where every cold start
 * evaluates this module. Migrations are not run here; see ./migrate.ts.
 *
 * Don't rely on foreign-key enforcement. SQLite leaves it off unless each
 * connection opts in, and Turso's remote sessions aren't pinned to one
 * connection, so ON DELETE CASCADE in the schema is documentation, not
 * behaviour — delete child rows explicitly (see users/service.ts reject()).
 */

import fs from 'fs';
import path from 'path';
import { createClient, Client } from '@libsql/client';
import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql';
import { config } from '../config';
import * as schema from './schema';

export type Database = LibSQLDatabase<typeof schema>;

let client: Client | null = null;
let dbInstance: Database | null = null;

function ensureLocalDirectory(url: string): void {
  if (!url.startsWith('file:')) {
    return;
  }
  const directory = path.dirname(url.slice('file:'.length));
  if (directory && !fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

export function getClient(): Client {
  if (!client) {
    ensureLocalDirectory(config.DATABASE_URL);
    client = createClient({ url: config.DATABASE_URL, authToken: config.DATABASE_AUTH_TOKEN });
  }
  return client;
}

export function getDb(): Database {
  if (!dbInstance) {
    dbInstance = drizzle(getClient(), { schema });
  }
  return dbInstance;
}

export const db: Database = getDb();
