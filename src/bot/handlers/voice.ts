/**
 * Voice message processing for Telegram bot. Transcribes via the calling
 * user's own LLM provider (same multimodal inlineData pattern as
 * src/portfolio/statement-parser.ts), then routes the transcript through
 * the same pipeline as typed text — split-flow state first, then
 * classification.
 */

import { getProviderForUser } from '../../llm/provider';
import { findById } from '../../users/service';
import { logger } from '../../utils/logger';
import { buildAssistantReply, classifyUserMessage } from '../ai';
import { getSplitState } from '../../split/state';
import { handleSplitTextMessage } from '../commands/split';
import { BotReply } from '../types';

export class VoiceTranscriptionError extends Error {}

export async function transcribeVoice(userId: string, audioBuffer: Buffer, mimeType: string): Promise<string> {
  try {
    const user = await findById(userId);
    if (!user) {
      throw new Error(`No user found with id ${userId}`);
    }
    const provider = getProviderForUser(user);

    // Voice notes are short (a few seconds), so this needs less headroom than
    // the 30s budget statement-parser.ts uses for dense multimodal PDFs.
    const response = await provider.generateText({
      systemInstruction:
        'You transcribe voice notes for a personal finance assistant. Return only the verbatim transcript as plain text, no commentary, no quotes.',
      contents: [
        { inlineData: { mimeType, data: audioBuffer.toString('base64') } },
        { text: 'Transcribe this voice note.' },
      ],
      timeoutMs: 20000,
    });

    return response.trim();
  } catch (error) {
    throw new VoiceTranscriptionError(`Gemini voice transcription failed: ${(error as Error).message}`);
  }
}

export async function handleVoiceMessage(
  chatId: number,
  userId: string,
  audioBuffer: Buffer,
  mimeType: string,
  targetTransactionId: string | null = null,
): Promise<BotReply> {
  let transcript: string;
  try {
    transcript = await transcribeVoice(userId, audioBuffer, mimeType);
  } catch (error) {
    logger.warn('Voice transcription failed', { message: (error as Error).message });
    return { text: "Sorry, I couldn't understand that voice note — try again or type it instead." };
  }

  if (!transcript) {
    return { text: "I couldn't make out anything in that voice note — try again or type it instead." };
  }

  if (await getSplitState(chatId)) {
    return { text: await handleSplitTextMessage(chatId, userId, transcript) };
  }

  const classification = await classifyUserMessage(userId, transcript);
  logger.debug('Classified transcribed voice message', {
    intent: classification.intent,
    confidence: classification.confidence,
    transcript,
  });

  const reply = await buildAssistantReply(userId, classification, { source: 'voice', targetTransactionId });
  return { ...reply, text: `Heard: "${transcript}"\n\n${reply.text}` };
}
