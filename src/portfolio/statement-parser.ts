/**
 * Parses an IBKR or Moomoo brokerage statement PDF into structured
 * holdings via Gemini multimodal. No rule-based/per-broker-parser
 * fallback — Pluto AI is Gemini-first (see CLAUDE.md); any failure here
 * is surfaced as StatementParseError, not guessed.
 *
 * NOTE: the prompt below has not yet been validated against real IBKR/
 * Moomoo statement PDFs (none were available when this was written) —
 * see the "Sample statements not yet provided" scope decision in the
 * spec. Revisit once real statements are available.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';
import { Broker, ParsedHolding, ParsedStatement } from './types';

export class StatementParseError extends Error {}

const SYSTEM_INSTRUCTION = `You are a financial statement parser for Pluto AI. You will receive a PDF of a brokerage statement from either Interactive Brokers (IBKR) or Moomoo. Identify which broker issued it from its layout/branding, then extract every open stock/ETF position from its "Open Positions" (IBKR) or "Positions" (Moomoo) section. Return strict JSON only, matching exactly this shape:
{"broker": "ibkr" | "moomoo", "holdings": [{"symbol": string, "name": string, "quantity": number, "asset_class": "stocks_us" | "stocks_my" | "stocks_sg", "currency": "USD" | "MYR" | "SGD", "market": string}]}
Do not include cash balances, options, or futures. If you cannot confidently identify the broker or find no open positions, return {"broker": null, "holdings": []}.`;

export function parseGeminiStatementResponse(rawText: string): ParsedStatement {
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new StatementParseError('Gemini returned an unparseable response');
  }

  let parsed: { broker?: string | null; holdings?: unknown[] };
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    throw new StatementParseError('Gemini returned invalid JSON');
  }

  if (parsed.broker !== 'ibkr' && parsed.broker !== 'moomoo') {
    throw new StatementParseError('Could not identify the statement broker');
  }

  const holdings = (parsed.holdings ?? []) as ParsedHolding[];
  if (holdings.length === 0) {
    throw new StatementParseError(
      'No holdings found in the statement — treated as a parse failure, not an emptied account',
    );
  }

  return { broker: parsed.broker as Broker, holdings };
}

export async function parseStatement(pdfBuffer: Buffer): Promise<ParsedStatement> {
  try {
    const genAI = new GoogleGenerativeAI(config.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      systemInstruction: SYSTEM_INSTRUCTION,
    });

    // Multimodal PDF calls run slower than short text-classification prompts
    // (ai.ts's 15s budget) — 30s gives enough headroom to not misfire.
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Gemini statement parse timed out after 30s')), 30000);
    });

    const result = await Promise.race([
      model.generateContent([
        { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { text: 'Extract the holdings as instructed and return only the JSON.' },
      ]),
      timeoutPromise,
    ]);

    return parseGeminiStatementResponse(result.response.text());
  } catch (error) {
    if (error instanceof StatementParseError) {
      throw error;
    }
    throw new StatementParseError(`Gemini statement parsing failed: ${(error as Error).message}`);
  }
}
