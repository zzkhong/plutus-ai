/**
 * Gemini-powered intent extraction and reply generation for the Telegram assistant
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';
import { logger } from '../utils/logger';
import { formatUserFriendlyError } from './formatter/messages';
import { BotIntent } from './types';

export interface ExtractedFields {
  amount?: number;
  merchant?: string;
  category?: string;
  period?: string;
  budgetAmount?: number;
  action?: string;
}

export interface IntentAnalysis {
  intent: BotIntent;
  confidence: number;
  extracted: ExtractedFields;
  rawText: string;
  /** Set when this result is a degraded response to a Gemini call failure, not a real classification. */
  serviceError?: boolean;
}

/**
 * Returned when Gemini itself fails (timeout, network error, unparseable response).
 * There is deliberately no rule-based classification here — Pluto AI is Gemini-first,
 * see doc/tasks/02-telegram-bot.md. A failure is surfaced as "unknown" with serviceError
 * set, not silently guessed via keyword matching.
 */
function gracefulUnknown(rawText: string): IntentAnalysis {
  return {
    intent: 'unknown',
    confidence: 0,
    extracted: {},
    rawText,
    serviceError: true,
  };
}

function safeJsonParse(text: string): Partial<IntentAnalysis> | null {
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function classifyUserMessage(rawText: string): Promise<IntentAnalysis> {
  const trimmed = rawText.trim();

  if (!trimmed) {
    return {
      intent: 'unknown',
      confidence: 0,
      extracted: {},
      rawText: '',
    };
  }

  try {
    const genAI = new GoogleGenerativeAI(config.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      systemInstruction:
        'You are Pluto AI, a personal finance assistant in Telegram. Classify each user message and return strict JSON only. Return fields: intent, confidence, extracted { amount, merchant, category, period, budgetAmount, action }, rawText. Allowed intents: expense, query, budget, correction, recurring, help, unknown. Use decimal numbers for money values like 4.5. Keep responses concise and practical.',
    });

    const prompt = `User message: "${trimmed}"\n\nReturn only valid JSON with keys intent, confidence, extracted, rawText.`;
    
    // gemini-3.6-flash's reasoning overhead routinely takes ~5s for this prompt,
    // so the timeout needs enough headroom to not misfire as a service error.
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Gemini API call timed out after 15s')), 15000);
    });
    
    const result = await Promise.race([
      model.generateContent(prompt),
      timeoutPromise,
    ]);
    
    const response = result.response.text();
    const parsed = safeJsonParse(response);

    if (!parsed) {
      logger.warn('Gemini returned an unparseable response, degrading to unknown intent', { response });
      return gracefulUnknown(trimmed);
    }

    const intent = (parsed.intent as BotIntent | undefined) ?? 'unknown';
    const confidence = Number(parsed.confidence ?? 0.7);

    return {
      intent,
      confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0.7,
      extracted: parsed.extracted ?? {},
      rawText: String(parsed.rawText ?? trimmed),
    };
  } catch (error) {
    logger.error('Gemini classification failed', error);
    return gracefulUnknown(trimmed);
  }
}

export function buildAssistantReply(result: IntentAnalysis): string {
  const { intent, extracted, rawText, serviceError } = result;

  if (serviceError) {
    return formatUserFriendlyError();
  }

  switch (intent) {
    case 'expense': {
      const amount = extracted.amount ?? 0;
      const merchant = extracted.merchant ?? 'your purchase';
      const category = extracted.category ?? 'Other';
      return `Got it — I’ve flagged this as an expense of $${amount.toFixed(2)} at ${merchant} in ${category}. I’ll send it through the spending flow once the expense engine is connected.`;
    }
    case 'budget': {
      const amount = extracted.budgetAmount ?? extracted.amount ?? 0;
      const category = extracted.category ?? 'your category';
      return `Nice, that looks like a budget update for ${category}. I’ll set the target to $${amount.toFixed(2)} and keep it synced with your monthly plan.`;
    }
    case 'correction': {
      return `Thanks for the correction — I’ll treat that as a revision to the last entry instead of a fresh expense.`;
    }
    case 'recurring': {
      return `That sounds like a recurring item. I’ll keep it in the recurring flow and make sure it gets handled as a repeat expense.`;
    }
    case 'query': {
      return `I can help with that: “${rawText}”. I’ll pull the relevant numbers and summarize the result for you once the data layer is live.`;
    }
    case 'help': {
      return `Here’s what I can do: /portfolio, /today, /month, /budget, /export, /undo, /help. You can also just message me naturally.`;
    }
    default:
      return `I’m not totally sure what you mean there, but I’m happy to help. Try /help or send something like “Spent $4.50 at Ya Kun”.`;
  }
}
