/**
 * Gemini implementation of LLMProvider. Model id is pinned the same way
 * every other Gemini call site in this codebase pins it.
 */

import { GoogleGenerativeAI, Tool } from '@google/generative-ai';
import type { ContentPart, GenerateTextParams, GroundedResult, LLMProvider } from './provider';
import { logger } from '../utils/logger';

const DEFAULT_TIMEOUT_MS = 15000;
const MODEL_ID = 'gemini-3.6-flash';

// Google Search grounding. The accepted tool shape has changed across model
// generations, so a rejected request here is expected rather than fatal —
// generateGroundedText falls back to an ungrounded call and reports it.
const SEARCH_GROUNDING_TOOL: Tool = { googleSearchRetrieval: {} };

export class GeminiProvider implements LLMProvider {
  constructor(private readonly apiKey: string) {}

  private async generate(
    params: GenerateTextParams & { contents: ContentPart[] },
    tools?: Tool[],
  ): Promise<string> {
    const genAI = new GoogleGenerativeAI(this.apiKey);
    const model = genAI.getGenerativeModel({
      model: MODEL_ID,
      systemInstruction: params.systemInstruction,
      ...(tools ? { tools } : {}),
    });

    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Gemini call timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      const result = await Promise.race([model.generateContent(params.contents), timeoutPromise]);
      return result.response.text();
    } finally {
      clearTimeout(timer!);
    }
  }

  async generateText(params: GenerateTextParams): Promise<string> {
    return this.generate(params);
  }

  async generateGroundedText(params: GenerateTextParams): Promise<GroundedResult> {
    try {
      return { text: await this.generate(params, [SEARCH_GROUNDING_TOOL]), grounded: true };
    } catch (error) {
      // Losing grounding degrades freshness, not the whole section — retry
      // plainly and let the caller caveat the answer.
      logger.warn('Gemini grounded call failed, retrying without search grounding', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { text: await this.generate(params), grounded: false };
    }
  }
}
