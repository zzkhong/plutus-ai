/**
 * Per-chat state for the /split flow, persisted in the split_sessions table.
 *
 * It used to live in an in-memory Map, which can't work on Vercel: each
 * Telegram update can land on a different function instance, so a receipt
 * photo and the "split it evenly" reply after it would not share a Map.
 *
 * Sessions expire after SPLIT_SESSION_TTL_MS without activity. While a split
 * is active, every text message is routed into it instead of normal
 * classification, so a forgotten /split must not capture messages forever —
 * in memory a restart used to clear it, but a database row would not.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { split_sessions } from '../db/schema';
import { ExtractedReceipt, SplitResult, SplitState } from './types';

export const SPLIT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function key(chatId: number): string {
  return String(chatId);
}

async function write(chatId: number, state: SplitState): Promise<void> {
  const now = Date.now();
  const serialized = JSON.stringify(state);
  await db
    .insert(split_sessions)
    .values({ chat_id: key(chatId), state: serialized, updated_at: now })
    .onConflictDoUpdate({ target: split_sessions.chat_id, set: { state: serialized, updated_at: now } });
}

export async function startSplit(chatId: number): Promise<void> {
  await write(chatId, { stage: 'awaiting_photo' });
}

/** `now` is injectable so tests can check expiry without waiting two hours. */
export async function getSplitState(chatId: number, now: number = Date.now()): Promise<SplitState | undefined> {
  const row = await db.select().from(split_sessions).where(eq(split_sessions.chat_id, key(chatId))).get();
  if (!row) {
    return undefined;
  }

  if (now - row.updated_at > SPLIT_SESSION_TTL_MS) {
    await db.delete(split_sessions).where(eq(split_sessions.chat_id, key(chatId)));
    return undefined;
  }

  return JSON.parse(row.state) as SplitState;
}

async function requireState(chatId: number): Promise<SplitState> {
  const current = await getSplitState(chatId);
  if (!current) {
    throw new Error(`No active split for chat ${chatId}`);
  }
  return current;
}

export async function setReceipt(chatId: number, receipt: ExtractedReceipt): Promise<void> {
  const current = await requireState(chatId);
  await write(chatId, { ...current, stage: 'awaiting_instructions', receipt });
}

export async function setPendingResult(chatId: number, result: SplitResult): Promise<void> {
  const current = await requireState(chatId);
  await write(chatId, { ...current, stage: 'awaiting_log_confirmation', pendingResult: result });
}

/** Returns whether there was an active (unexpired) split to clear. */
export async function clearSplit(chatId: number): Promise<boolean> {
  const existed = (await getSplitState(chatId)) !== undefined;
  await db.delete(split_sessions).where(eq(split_sessions.chat_id, key(chatId)));
  return existed;
}
