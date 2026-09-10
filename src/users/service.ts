/**
 * User CRUD (Drizzle-backed).
 */

import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { LLMProviderName, User, UserStatus } from './types';

function mapUserRow(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    telegram_chat_id: row.telegram_chat_id,
    status: row.status as UserStatus,
    is_admin: Boolean(row.is_admin),
    llm_provider: (row.llm_provider as LLMProviderName | null) ?? null,
    llm_api_key_encrypted: row.llm_api_key_encrypted ?? null,
    webhook_api_key: row.webhook_api_key ?? null,
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
  };
}

export async function createUser(telegramChatId: string): Promise<User> {
  const now = Date.now();
  const [inserted] = await db
    .insert(users)
    .values({
      id: randomUUID(),
      telegram_chat_id: telegramChatId,
      status: 'onboarding',
      is_admin: 0,
      created_at: now,
      updated_at: now,
    })
    .returning();
  return mapUserRow(inserted);
}

export async function setProvider(userId: string, provider: LLMProviderName): Promise<User> {
  const [updated] = await db
    .update(users)
    .set({ llm_provider: provider, status: 'onboarding', updated_at: Date.now() })
    .where(eq(users.id, userId))
    .returning();
  if (!updated) {
    throw new Error(`No user found with id ${userId}`);
  }
  return mapUserRow(updated);
}

/** Resets an already-configured user back to the start of onboarding — used when re-running /setup. */
export async function restartOnboarding(userId: string): Promise<User> {
  const [updated] = await db
    .update(users)
    .set({ status: 'onboarding', llm_provider: null, updated_at: Date.now() })
    .where(eq(users.id, userId))
    .returning();
  if (!updated) {
    throw new Error(`No user found with id ${userId}`);
  }
  return mapUserRow(updated);
}

/**
 * Stores the validated, encrypted API key. Auto-approves when `isAdmin` is
 * true (ADMIN_CHAT_ID's first setup); otherwise a first-time completion goes
 * to 'pending_approval', while a returning user (one who already had an
 * encrypted key — i.e. rotating their key) goes straight back to 'approved',
 * reusing their existing webhook_api_key instead of generating a new one.
 */
export async function completeSetup(userId: string, encryptedApiKey: string, isAdmin: boolean): Promise<User> {
  const existing = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!existing) {
    throw new Error(`No user found with id ${userId}`);
  }

  const isRotation = existing.llm_api_key_encrypted !== null;
  const webhookApiKey = existing.webhook_api_key ?? randomUUID();
  const status: UserStatus = isRotation || isAdmin ? 'approved' : 'pending_approval';

  const [updated] = await db
    .update(users)
    .set({
      llm_api_key_encrypted: encryptedApiKey,
      webhook_api_key: webhookApiKey,
      status,
      is_admin: isAdmin ? 1 : existing.is_admin,
      updated_at: Date.now(),
    })
    .where(eq(users.id, userId))
    .returning();

  return mapUserRow(updated);
}

export async function approve(userId: string): Promise<User> {
  const [updated] = await db
    .update(users)
    .set({ status: 'approved', updated_at: Date.now() })
    .where(eq(users.id, userId))
    .returning();
  if (!updated) {
    throw new Error(`No user found with id ${userId}`);
  }
  return mapUserRow(updated);
}

export async function reject(userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}

export async function findByChatId(telegramChatId: string): Promise<User | null> {
  const row = await db.select().from(users).where(eq(users.telegram_chat_id, telegramChatId)).get();
  return row ? mapUserRow(row) : null;
}

export async function findByWebhookKey(webhookApiKey: string): Promise<User | null> {
  const row = await db.select().from(users).where(eq(users.webhook_api_key, webhookApiKey)).get();
  return row ? mapUserRow(row) : null;
}

export async function findById(userId: string): Promise<User | null> {
  const row = await db.select().from(users).where(eq(users.id, userId)).get();
  return row ? mapUserRow(row) : null;
}

export async function listApproved(): Promise<User[]> {
  const rows = await db.select().from(users).where(eq(users.status, 'approved'));
  return rows.map(mapUserRow);
}
