/**
 * LLM provider abstraction. One implementation (Gemini) today — this
 * interface is what lets a later slice add OpenAI/Anthropic without
 * touching any call site again.
 */

import { decrypt } from '../users/crypto';
import { User } from '../users/types';
import { GeminiProvider } from './gemini';

export type ContentPart = { text: string } | { inlineData: { mimeType: string; data: string } };

export interface GenerateTextParams {
  systemInstruction: string;
  contents: ContentPart[];
  timeoutMs?: number;
}

export interface GroundedResult {
  text: string;
  /**
   * False when the answer came from the model's training data rather than a
   * live web search — either the provider has no grounding tool, or the
   * grounded call was rejected and we fell back. Callers are expected to
   * caveat the output when this is false.
   */
  grounded: boolean;
}

export interface LLMProvider {
  generateText(params: GenerateTextParams): Promise<string>;

  /**
   * Generates using the provider's native web-search grounding where it has
   * one. Implementations must still return text with `grounded: false`
   * rather than throwing when grounding is unavailable — a missing search
   * tool is not an error, it just makes the answer less current.
   */
  generateGroundedText(params: GenerateTextParams): Promise<GroundedResult>;
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
