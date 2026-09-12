/**
 * Handles each chat's updates one at a time, in the order Telegram sent them.
 *
 * On Vercel the webhook acknowledges an update at once and handles it in the
 * background, so two messages sent seconds apart are handled at the same
 * time — possibly by different function instances. "Kopi 4.50" followed by
 * "actually 5" could then correct the expense before it, and a /split could
 * see its answers out of order. So each update registers in chat_updates and
 * waits until every earlier update from its chat has finished. It has to be
 * the database: function instances share nothing else.
 *
 * Long polling (the standalone process) already handles updates one at a
 * time, so there it never waits.
 */

import type { Context, NextFunction } from 'grammy';
import { and, eq, gt, lt } from 'drizzle-orm';
import { db } from '../../db';
import { chat_updates } from '../../db/schema';
import { logger } from '../../utils/logger';

export interface ChatSequencerOptions {
  /** How often a waiting update checks again. */
  pollMs?: number;
  /** The longest an update waits before going ahead anyway: late and out of order beats never answered. */
  maxWaitMs?: number;
  /** A registration older than this belongs to an instance that died mid-update, and is ignored. */
  staleMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createChatSequencer(options: ChatSequencerOptions = {}) {
  const pollMs = options.pollMs ?? 250;
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  const staleMs = options.staleMs ?? 180_000;

  return async (ctx: Context, next: NextFunction): Promise<void> => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      await next();
      return;
    }
    const chat = String(chatId);
    const updateId = ctx.update.update_id;

    await db.batch([
      // Clears what a crashed instance left behind, while it's here.
      db.delete(chat_updates).where(and(eq(chat_updates.chat_id, chat), lt(chat_updates.started_at, Date.now() - staleMs))),
      db.insert(chat_updates).values({ update_id: updateId, chat_id: chat, started_at: Date.now() }).onConflictDoNothing(),
    ]);

    try {
      const deadline = Date.now() + maxWaitMs;
      for (;;) {
        const earlier = await db
          .select({ update_id: chat_updates.update_id })
          .from(chat_updates)
          .where(
            and(
              eq(chat_updates.chat_id, chat),
              lt(chat_updates.update_id, updateId),
              gt(chat_updates.started_at, Date.now() - staleMs),
            ),
          )
          .limit(1)
          .get();
        if (!earlier) {
          break;
        }
        if (Date.now() >= deadline) {
          logger.warn(`Update ${updateId} stopped waiting for update ${earlier.update_id} from the same chat`);
          break;
        }
        await sleep(pollMs);
      }

      await next();
    } finally {
      try {
        await db.delete(chat_updates).where(eq(chat_updates.update_id, updateId));
      } catch (error) {
        logger.error(`Failed to clear finished update ${updateId}`, error);
      }
    }
  };
}

export const chatSequencer = createChatSequencer();
