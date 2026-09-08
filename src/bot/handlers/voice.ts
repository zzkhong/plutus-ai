/**
 * Voice message processing for Telegram bot. Transcribes via Gemini's
 * native audio input (same multimodal inlineData pattern as
 * src/portfolio/statement-parser.ts), then routes the transcript through
 * the same pipeline as typed text — split-flow state first, then
 * classification. No dedicated STT provider: Pluto AI is Gemini-first
 * with no rule-based fallback (see CLAUDE.md).
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { buildAssistantReply, classifyUserMessage } from '../ai';
import { getSplitState } from '../../split/state';
import { handleSplitTextMessage } from '../commands/split';

export class VoiceTranscriptionError extends Error {}

export async function transcribeVoice(audioBuffer: Buffer, mimeType: string): Promise<string> {
  try {
    const genAI = new GoogleGenerativeAI(config.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      systemInstruction:
        'You transcribe voice notes for a personal finance assistant. Return only the verbatim transcript as plain text, no commentary, no quotes.',
    });

    // Voice notes are short (a few seconds), so this needs less headroom than
    // the 30s budget statement-parser.ts uses for dense multimodal PDFs.
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Gemini voice transcription timed out after 20s')), 20000);
    });

    const result = await Promise.race([
      model.generateContent([
        { inlineData: { mimeType, data: audioBuffer.toString('base64') } },
        { text: 'Transcribe this voice note.' },
      ]),
      timeoutPromise,
    ]);

    return result.response.text().trim();
  } catch (error) {
    throw new VoiceTranscriptionError(`Gemini voice transcription failed: ${(error as Error).message}`);
  }
}

export async function handleVoiceMessage(chatId: number, audioBuffer: Buffer, mimeType: string): Promise<string> {
  let transcript: string;
  try {
    transcript = await transcribeVoice(audioBuffer, mimeType);
  } catch (error) {
    logger.warn('Voice transcription failed', { message: (error as Error).message });
    return "Sorry, I couldn't understand that voice note — try again or type it instead.";
  }

  if (!transcript) {
    return "I couldn't make out anything in that voice note — try again or type it instead.";
  }

  if (getSplitState(chatId)) {
    return handleSplitTextMessage(chatId, transcript);
  }

  const classification = await classifyUserMessage(transcript);
  logger.debug('Classified transcribed voice message', {
    intent: classification.intent,
    confidence: classification.confidence,
    transcript,
  });

  const reply = await buildAssistantReply(classification, 'voice');
  return `Heard: "${transcript}"\n\n${reply}`;
}
