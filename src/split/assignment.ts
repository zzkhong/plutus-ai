/**
 * Matches a user's free-text description of who had what against the
 * receipt's extracted line items via Gemini. No rule-based fallback —
 * any failure surfaces as AssignmentParseError, matching this module's
 * other Gemini call (extraction.ts).
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';
import { ItemAssignment, ReceiptItem, SplitInstructions } from './types';

export class AssignmentParseError extends Error {}

function buildSystemInstruction(items: ReceiptItem[]): string {
  const itemList = items.map((item) => `- ${item.name} ($${item.price.toFixed(2)})`).join('\n');
  return `You are helping split a restaurant bill for Pluto AI. Here are the receipt's line items:
${itemList}

The user will describe how to split the bill, either as a headcount for an even split (e.g. "split between 3") or by saying who had what (e.g. "Alice had the burger, I had the salad, split the fries between us"). Return strict JSON only, matching exactly this shape:
{"mode": "even" | "itemized", "headcount": number | null, "itemAssignments": [{"itemName": string, "personLabels": string[]}] | null, "requesterLabel": string | null}
For "itemized" mode, itemName must exactly match one of the line items above, and every line item must be assigned to at least one person. personLabels with more than one name means that item is shared evenly between them. requesterLabel is whichever label represents the user speaking (from words like "I"/"me") — use the exact label they used (e.g. "me"). If you cannot tell which label is the requester, set requesterLabel to null. For "even" mode, set headcount and leave itemAssignments null. If the message doesn't clearly describe either an even split or a full item assignment, return {"mode": null}.`;
}

export function parseGeminiAssignmentResponse(rawText: string, validItemNames: string[]): SplitInstructions {
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new AssignmentParseError('Gemini returned an unparseable response');
  }

  let parsed: {
    mode?: string | null;
    headcount?: unknown;
    itemAssignments?: unknown[] | null;
    requesterLabel?: string | null;
  };
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    throw new AssignmentParseError('Gemini returned invalid JSON');
  }

  if (parsed.mode === 'even') {
    if (typeof parsed.headcount !== 'number' || !Number.isInteger(parsed.headcount) || parsed.headcount <= 0) {
      throw new AssignmentParseError('Even split is missing a valid headcount');
    }
    return { mode: 'even', headcount: parsed.headcount, requesterLabel: parsed.requesterLabel ?? null };
  }

  if (parsed.mode === 'itemized') {
    const rawAssignments = parsed.itemAssignments;
    if (!Array.isArray(rawAssignments) || rawAssignments.length === 0) {
      throw new AssignmentParseError('Itemized split has no item assignments');
    }

    const validNames = new Set(validItemNames);
    const assignedNames = new Set<string>();

    const itemAssignments: ItemAssignment[] = rawAssignments.map((raw, index) => {
      if (typeof raw !== 'object' || raw === null) {
        throw new AssignmentParseError(`Assignment ${index} is not a valid object`);
      }
      const assignment = raw as Record<string, unknown>;
      if (typeof assignment.itemName !== 'string' || !validNames.has(assignment.itemName)) {
        throw new AssignmentParseError(`Assignment ${index} references an unknown item`);
      }
      if (assignedNames.has(assignment.itemName)) {
        throw new AssignmentParseError(`Item "${assignment.itemName}" was assigned more than once`);
      }
      const personLabels = assignment.personLabels;
      if (
        !Array.isArray(personLabels) ||
        personLabels.length === 0 ||
        !personLabels.every((l) => typeof l === 'string')
      ) {
        throw new AssignmentParseError(`Assignment ${index} (${assignment.itemName}) has no valid people assigned`);
      }
      assignedNames.add(assignment.itemName);
      return { itemName: assignment.itemName, personLabels: personLabels as string[] };
    });

    const missing = validItemNames.filter((name) => !assignedNames.has(name));
    if (missing.length > 0) {
      throw new AssignmentParseError(`These items were not assigned to anyone: ${missing.join(', ')}`);
    }

    return { mode: 'itemized', itemAssignments, requesterLabel: parsed.requesterLabel ?? null };
  }

  throw new AssignmentParseError('Could not determine an even split or item assignment from that message');
}

export async function parseSplitInstructions(freeText: string, items: ReceiptItem[]): Promise<SplitInstructions> {
  try {
    const genAI = new GoogleGenerativeAI(config.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      systemInstruction: buildSystemInstruction(items),
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Gemini split instruction parsing timed out after 15s')), 15000);
    });

    const result = await Promise.race([
      model.generateContent(`User's message: "${freeText}"\n\nReturn only the JSON.`),
      timeoutPromise,
    ]);

    return parseGeminiAssignmentResponse(
      result.response.text(),
      items.map((item) => item.name),
    );
  } catch (error) {
    if (error instanceof AssignmentParseError) {
      throw error;
    }
    throw new AssignmentParseError(`Gemini split instruction parsing failed: ${(error as Error).message}`);
  }
}
