/**
 * Gemini implementation of LLMProvider. Model id is pinned the same way
 * every other Gemini call site in this codebase pins it.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ContentPart, LLMProvider } from './provider';

const DEFAULT_TIMEOUT_MS = 15000;

export class GeminiProvider implements LLMProvider {
  constructor(private readonly apiKey: string) {}

  async generateText(params: {
    systemInstruction: string;
    contents: ContentPart[];
    timeoutMs?: number;
  }): Promise<string> {
    const genAI = new GoogleGenerativeAI(this.apiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      systemInstruction: params.systemInstruction,
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
}
