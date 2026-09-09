/**
 * LLM provider abstraction. One implementation (Gemini) today — this
 * interface is what lets a later slice add OpenAI/Anthropic without
 * touching any call site again.
 */

import { decrypt } from '../users/crypto';
import { User } from '../users/types';
import { GeminiProvider } from './gemini';

export type ContentPart = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface LLMProvider {
  generateText(params: { systemInstruction: string; contents: ContentPart[]; timeoutMs?: number }): Promise<string>;
}

export function getProviderForUser(user: User): LLMProvider {
  if (!user.llm_provider || !user.llm_api_key_encrypted) {
    throw new Error(`User ${user.id} has no configured LLM provider — they must complete /setup first`);
  }

  const apiKey = decrypt(user.llm_api_key_encrypted);

  switch (user.llm_provider) {
    case 'gemini':
      return new GeminiProvider(apiKey);
    default:
      throw new Error(`Unsupported LLM provider "${user.llm_provider}"`);
  }
}
