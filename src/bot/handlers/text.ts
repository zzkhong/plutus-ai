/**
 * Free-text message processing for Telegram bot
 */

import { logger } from '../../utils/logger';
import { buildAssistantReply, classifyUserMessage } from '../ai';

export async function classifyIntent(message: string): Promise<{ intent: string; confidence: number; text: string }> {
  const result = await classifyUserMessage(message);
  return {
    intent: result.intent,
    confidence: result.confidence,
    text: result.rawText,
  };
}

export async function handleTextMessage(message: string): Promise<string> {
  const classification = await classifyUserMessage(message);
  logger.debug('Classified Telegram message', {
    intent: classification.intent,
    confidence: classification.confidence,
    rawText: classification.rawText,
  });

  return buildAssistantReply(classification);
}
