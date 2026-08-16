/**
 * Voice message processing for Telegram bot
 */

import { logger } from '../../utils/logger';

export async function handleVoiceMessage(_voiceFileId: string): Promise<string> {
  logger.info('Voice message received', { voiceFileId: _voiceFileId });

  return 'Voice note received. Transcription will be processed and routed like normal text once the speech-to-text layer is connected.';
}
