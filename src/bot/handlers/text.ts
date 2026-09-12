/**
 * Free-text message processing for Telegram bot
 */

import { logger } from '../../utils/logger';
import { buildAssistantReply, classifyUserMessage } from '../ai';
import { BotReply } from '../types';

export async function classifyIntent(userId: string, message: string): Promise<{ intent: string; confidence: number; text: string }> {
  const result = await classifyUserMessage(userId, message);
  return {
    intent: result.intent,
    confidence: result.confidence,
    text: result.rawText,
  };
}

/**
 * `targetTransactionId` is set when the message is a reply to an expense's
 * confirmation (or a /recent entry), so a correction changes that expense
 * rather than the latest.
 */
export async function handleTextMessage(
  userId: string,
  message: string,
  targetTransactionId: string | null = null,
): Promise<BotReply> {
  const classification = await classifyUserMessage(userId, message);
  logger.debug('Classified Telegram message', {
    intent: classification.intent,
    confidence: classification.confidence,
    rawText: classification.rawText,
  });

  return buildAssistantReply(userId, classification, { targetTransactionId });
}
