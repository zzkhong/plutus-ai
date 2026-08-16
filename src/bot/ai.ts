/**
 * Gemini-powered intent extraction and reply generation for the Telegram assistant
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';
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
}

const fallbackPatterns: Array<{ intent: BotIntent; match: (text: string) => boolean }> = [
  {
    intent: 'expense',
    match: (text) => /(spent|expense|log|paid|bought|charged)/i.test(text),
  },
  {
    intent: 'budget',
    match: (text) => /(budget|set .* budget|limit)/i.test(text),
  },
  {
    intent: 'correction',
    match: (text) => /(last one|actually|correction|not .*|wrong)/i.test(text),
  },
  {
    intent: 'recurring',
    match: (text) => /(every|monthly|weekly|recurring|every 1st|rent)/i.test(text),
  },
  {
    intent: 'query',
    match: (text) => /(how much|what did|show|summary|portfolio|spend)/i.test(text),
  },
];

function fallbackIntentAnalysis(rawText: string): IntentAnalysis {
  const trimmed = rawText.trim();
  const intentEntry = fallbackPatterns.find(({ match }) => match(trimmed)) ?? {
    intent: 'unknown' as BotIntent,
    match: () => false,
  };

  return {
    intent: intentEntry.intent,
    confidence: intentEntry.intent === 'unknown' ? 0.1 : 0.75,
    extracted: extractFieldsFromText(trimmed),
    rawText: trimmed,
  };
}

function extractFieldsFromText(rawText: string): ExtractedFields {
  const result: ExtractedFields = {};

  const moneyMatch = rawText.match(/\$?\s?(\d+(?:\.\d{1,2})?)/i);
  if (moneyMatch) {
    result.amount = Number(moneyMatch[1]);
  }

  const merchantMatch = rawText.match(/at\s+([A-Za-z0-9 &'-]+)/i)
    ?? rawText.match(/for\s+([A-Za-z0-9 &'-]+)/i);
  if (merchantMatch) {
    result.merchant = merchantMatch[1].trim();
  }

  if (/food|coffee|lunch|dinner|snack/i.test(rawText)) {
    result.category = 'Food';
  } else if (/transport|grab|uber|taxi|train|bus|mrt/i.test(rawText)) {
    result.category = 'Transport';
  } else if (/rent|mortgage|housing/i.test(rawText)) {
    result.category = 'Utilities';
  }

  if (/month|monthly/i.test(rawText)) {
    result.period = 'month';
  } else if (/today|daily/i.test(rawText)) {
    result.period = 'today';
  }

  if (/budget.*\$?\s?(\d+(?:\.\d{1,2})?)/i.test(rawText)) {
    const budgetMatch = rawText.match(/budget.*\$?\s?(\d+(?:\.\d{1,2})?)/i);
    if (budgetMatch) {
      result.budgetAmount = Number(budgetMatch[1]);
    }
  }

  return result;
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

  if (!config.GOOGLE_API_KEY) {
    return fallbackIntentAnalysis(trimmed);
  }

  try {
    const genAI = new GoogleGenerativeAI(config.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction:
        'You are Pluto AI, a personal finance assistant in Telegram. Classify each user message and return strict JSON only. Return fields: intent, confidence, extracted { amount, merchant, category, period, budgetAmount, action }, rawText. Allowed intents: expense, query, budget, correction, recurring, help, unknown. Use decimal numbers for money values like 4.5. Keep responses concise and practical.',
    });

    const prompt = `User message: "${trimmed}"\n\nReturn only valid JSON with keys intent, confidence, extracted, rawText.`;
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    const parsed = safeJsonParse(response);

    if (!parsed) {
      return fallbackIntentAnalysis(trimmed);
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
    console.warn('Gemini classification failed, falling back to local heuristic', error);
    return fallbackIntentAnalysis(trimmed);
  }
}

export function buildAssistantReply(result: IntentAnalysis): string {
  const { intent, extracted, rawText } = result;

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
