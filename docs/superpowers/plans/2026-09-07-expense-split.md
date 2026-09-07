# Expense Split (PLUTO-08) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chat-driven bill-splitting calculator: `/split`, then a photo of a receipt, then either a headcount for an even split or free text saying who had what, producing a per-person breakdown and optionally logging only the requester's own share as a real expense.

**Architecture:** A new `src/split/` module — pure calculation (`calculator.ts`), two Gemini-multimodal/text extraction functions following the exact degrade-don't-guess convention already used by `src/portfolio/statement-parser.ts` (`extraction.ts` for the receipt photo, `assignment.ts` for matching free text to line items), and in-memory per-chat conversation state (`state.ts`). A new `src/bot/commands/split.ts` orchestrates the flow and is wired into `src/bot/index.ts` via `/split`, `/cancel`, a new `message:photo` handler, and an early check inside the existing `message:text` handler.

**Tech Stack:** TypeScript, `@google/generative-ai` (multimodal + text), grammy, node:test.

**Spec:** [docs/superpowers/specs/2026-09-07-expense-split-design.md](../specs/2026-09-07-expense-split-design.md)

## Global Constraints

- All monetary math inside `src/split/` (extraction, assignment, calculator) works in **decimal dollars**, matching `ExpenseInput.amount`'s convention (`src/expense/types.ts`) — never cents. Only `formatCurrency` calls need `Math.round(x * 100)` to convert to cents for display, since `formatCurrency(amount, currency)` expects cents (see every existing call site, e.g. `src/portfolio/index.ts`'s `formatCurrency(summary.net_worth_sgd, 'SGD')`).
- No rule-based/keyword fallback for any Gemini call in this module — `extraction.ts` and `assignment.ts` throw a typed error (`ExtractionError`, `AssignmentParseError`) on any failure (timeout, network error, unparseable JSON, invalid shape), matching `classifyUserMessage`'s and `statement-parser.ts`'s degrade-don't-guess convention. Never guess a value that failed to parse.
- Model id is pinned to `gemini-3.6-flash`, same as every other Gemini call site in this codebase. Multimodal (photo) calls get a 30s timeout (matches `statement-parser.ts`); text-only calls (assignment parsing) get 15s (matches `ai.ts`'s classification timeout).
- Conversation state (`src/split/state.ts`) is an in-memory `Map<number, SplitState>` keyed by Telegram `chat_id` — **not** persisted to the DB. A bot restart mid-flow loses it; the user just runs `/split` again.
- Only the requester's own calculated share is ever passed to `logExpense`. Other participants' shares exist only in the reply text — never persisted anywhere.
- New test files must be added to the `test` script in `package.json` or they will not run under `npm test`.
- Test files that touch the database must set `process.env.DATABASE_URL` to a dedicated, non-shared test db path *before* importing anything that transitively loads `src/config/env.ts`, delete any stale file at that path, then call `runMigrations()` from `src/db/migrate.ts` in a `before()` hook — the existing pattern in `src/bot/handlers/document.test.ts` and `src/expense/expense.test.ts`.
- `logExpense` already infers the category itself (`src/expense/service.ts` calls `inferCategory` internally and returns it on the resulting `Transaction`) — never call `inferCategory` a second time from `src/split/`.

---

## File Structure

```
src/split/
├── types.ts                    # create: ReceiptItem, ExtractedReceipt, ItemAssignment, SplitInstructions, PersonShare, SplitResult, SplitStage, SplitState
├── calculator.ts                # create: calculateEvenSplit, calculateItemizedSplit
├── calculator.test.ts           # create
├── extraction.ts                 # create: extractReceipt, parseGeminiReceiptResponse, ExtractionError
├── extraction.test.ts            # create
├── assignment.ts                  # create: parseSplitInstructions, parseGeminiAssignmentResponse, AssignmentParseError
├── assignment.test.ts             # create
├── state.ts                        # create: startSplit, getSplitState, setReceipt, setPendingResult, clearSplit
└── state.test.ts                   # create

src/bot/commands/split.ts        # create: handleSplitCommand, handleCancelCommand, handleSplitPhoto, handleSplitTextMessage
src/bot/commands/split.test.ts   # create
src/bot/index.ts                 # modify: wire /split, /cancel, message:photo; check split state in message:text
src/bot/formatter/messages.ts    # modify: add /split to formatHelpMessage

package.json                     # modify: register new test files
docs/tasks/08-expense-split.md   # modify: check off implemented acceptance criteria
```

---

### Task 1: Types

**Files:**
- Create: `src/split/types.ts`

**Interfaces:**
- Consumes: `Currency` from `../types` (existing).
- Produces: `ReceiptItem`, `ExtractedReceipt`, `ItemAssignment`, `SplitInstructions`, `PersonShare`, `SplitResult`, `SplitStage`, `SplitState`.

- [ ] **Step 1: Write `types.ts`**

```typescript
/**
 * Expense split module types
 */

import { Currency } from '../types';

export interface ReceiptItem {
  name: string;
  price: number; // decimal dollars, e.g. 12.50 — see Global Constraints
}

export interface ExtractedReceipt {
  merchant: string | null;
  items: ReceiptItem[];
  taxAndTip: number; // sum of tax/service charge/tip lines, decimal dollars
  total: number; // decimal dollars
  currency: Currency;
}

export interface ItemAssignment {
  itemName: string; // must exactly match a ReceiptItem.name
  personLabels: string[]; // 1 label = exclusive; >1 = shared evenly among them
}

export interface SplitInstructions {
  mode: 'even' | 'itemized';
  headcount?: number; // present when mode === 'even'
  itemAssignments?: ItemAssignment[]; // present when mode === 'itemized'
  requesterLabel: string | null; // which label is "I"/"me"; null if ambiguous
}

export interface PersonShare {
  label: string;
  itemSubtotal: number;
  taxAndTipShare: number;
  total: number;
}

export interface SplitResult {
  shares: PersonShare[];
  requesterShare: PersonShare | null;
}

export type SplitStage = 'awaiting_photo' | 'awaiting_instructions' | 'awaiting_log_confirmation';

export interface SplitState {
  stage: SplitStage;
  receipt?: ExtractedReceipt;
  pendingResult?: SplitResult;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors (this file has no runtime behavior to test).

- [ ] **Step 3: Commit**

```bash
git add src/split/types.ts
git commit -m "feat(split): add expense split module types"
```

---

### Task 2: Split calculator (pure math)

**Files:**
- Create: `src/split/calculator.ts`
- Create: `src/split/calculator.test.ts`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `ItemAssignment`, `PersonShare`, `ReceiptItem`, `SplitResult` from `./types` (Task 1).
- Produces:
  - `calculateEvenSplit(total: number, headcount: number): SplitResult`
  - `calculateItemizedSplit(items: ReceiptItem[], taxAndTip: number, itemAssignments: ItemAssignment[], requesterLabel: string | null): SplitResult`

- [ ] **Step 1: Write the failing test**

Create `src/split/calculator.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateEvenSplit, calculateItemizedSplit } from './calculator';
import { ReceiptItem } from './types';

test('calculateEvenSplit divides a total with no remainder evenly across headcount', () => {
  const result = calculateEvenSplit(30, 3);

  assert.equal(result.shares.length, 3);
  assert.deepEqual(
    result.shares.map((s) => s.total),
    [10, 10, 10],
  );
  assert.equal(result.shares[0].label, 'You');
  assert.equal(result.shares[1].label, 'Person 2');
  assert.equal(result.requesterShare, result.shares[0]);
});

test('calculateEvenSplit absorbs rounding remainder into the last share so totals sum exactly', () => {
  const result = calculateEvenSplit(10, 3);
  const sum = result.shares.reduce((acc, s) => acc + s.total, 0);

  assert.ok(Math.abs(sum - 10) < 0.001);
  assert.equal(result.shares[0].total, 3.33);
  assert.equal(result.shares[1].total, 3.33);
  assert.equal(result.shares[2].total, 3.34);
});

test('calculateEvenSplit throws for a non-positive or non-integer headcount', () => {
  assert.throws(() => calculateEvenSplit(30, 0));
  assert.throws(() => calculateEvenSplit(30, -1));
  assert.throws(() => calculateEvenSplit(30, 1.5));
});

function fakeItems(): ReceiptItem[] {
  return [
    { name: 'Burger', price: 12 },
    { name: 'Salad', price: 8 },
    { name: 'Fries', price: 4 },
  ];
}

test('calculateItemizedSplit assigns exclusive items and applies tax/tip proportionally to item subtotal', () => {
  const result = calculateItemizedSplit(
    fakeItems(),
    2, // taxAndTip
    [
      { itemName: 'Burger', personLabels: ['Alice'] },
      { itemName: 'Salad', personLabels: ['me'] },
      { itemName: 'Fries', personLabels: ['me'] },
    ],
    'me',
  );

  const alice = result.shares.find((s) => s.label === 'Alice')!;
  const me = result.shares.find((s) => s.label === 'me')!;

  // Alice: 12/24 of items -> 12/24 of tax/tip (1.00); me: 12/24 -> 1.00
  assert.equal(alice.itemSubtotal, 12);
  assert.equal(alice.taxAndTipShare, 1);
  assert.equal(alice.total, 13);
  assert.equal(me.itemSubtotal, 12);
  assert.equal(me.total, 13);
  assert.equal(result.requesterShare, me);
});

test('calculateItemizedSplit splits a shared item evenly between its assigned people before tax/tip', () => {
  const result = calculateItemizedSplit(
    fakeItems(),
    0,
    [
      { itemName: 'Burger', personLabels: ['Alice'] },
      { itemName: 'Salad', personLabels: ['me'] },
      { itemName: 'Fries', personLabels: ['Alice', 'me'] },
    ],
    'me',
  );

  const alice = result.shares.find((s) => s.label === 'Alice')!;
  const me = result.shares.find((s) => s.label === 'me')!;

  assert.equal(alice.itemSubtotal, 14); // 12 + 2 (half of Fries)
  assert.equal(me.itemSubtotal, 10); // 8 + 2 (half of Fries)
});

test('calculateItemizedSplit returns a null requesterShare when requesterLabel is null or not among the shares', () => {
  const assignments = [
    { itemName: 'Burger', personLabels: ['Alice'] },
    { itemName: 'Salad', personLabels: ['Bob'] },
    { itemName: 'Fries', personLabels: ['Bob'] },
  ];

  const nullLabel = calculateItemizedSplit(fakeItems(), 0, assignments, null);
  assert.equal(nullLabel.requesterShare, null);

  const unknownLabel = calculateItemizedSplit(fakeItems(), 0, assignments, 'Charlie');
  assert.equal(unknownLabel.requesterShare, null);
});

test('calculateItemizedSplit throws when an assignment references an item not in the receipt', () => {
  assert.throws(() =>
    calculateItemizedSplit(fakeItems(), 0, [{ itemName: 'Dessert', personLabels: ['me'] }], 'me'),
  );
});

test('calculateItemizedSplit keeps every share total summing exactly to items total + taxAndTip', () => {
  const items: ReceiptItem[] = [
    { name: 'A', price: 7.33 },
    { name: 'B', price: 5.5 },
    { name: 'C', price: 3.17 },
  ];
  const result = calculateItemizedSplit(
    items,
    1.23,
    [
      { itemName: 'A', personLabels: ['me'] },
      { itemName: 'B', personLabels: ['Alice'] },
      { itemName: 'C', personLabels: ['me', 'Alice'] },
    ],
    'me',
  );

  const sum = result.shares.reduce((acc, s) => acc + s.total, 0);
  const expected = items.reduce((acc, i) => acc + i.price, 0) + 1.23;
  assert.ok(Math.abs(sum - expected) < 0.005);
});
```

- [ ] **Step 2: Register the test file and run it to see it fail**

In `package.json`, append `src/split/calculator.test.ts` to the `test` script (comma-separated list stays a single space-separated string passed to `tsx --test`).

Run: `npx tsx --test src/split/calculator.test.ts`
Expected: FAIL — `Cannot find module './calculator'`.

- [ ] **Step 3: Write `calculator.ts`**

```typescript
/**
 * Pure bill-splitting math. No I/O — takes an already-extracted receipt
 * plus a parsed set of instructions and produces per-person shares.
 */

import { ItemAssignment, PersonShare, ReceiptItem, SplitResult } from './types';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function calculateEvenSplit(total: number, headcount: number): SplitResult {
  if (!Number.isInteger(headcount) || headcount <= 0) {
    throw new Error('headcount must be a positive integer');
  }

  const rawShare = round2(total / headcount);
  const shares: PersonShare[] = [];
  let allocated = 0;

  for (let i = 0; i < headcount; i++) {
    const isLast = i === headcount - 1;
    const shareTotal = isLast ? round2(total - allocated) : rawShare;
    allocated = round2(allocated + shareTotal);

    shares.push({
      label: i === 0 ? 'You' : `Person ${i + 1}`,
      itemSubtotal: shareTotal,
      taxAndTipShare: 0,
      total: shareTotal,
    });
  }

  return { shares, requesterShare: shares[0] };
}

export function calculateItemizedSplit(
  items: ReceiptItem[],
  taxAndTip: number,
  itemAssignments: ItemAssignment[],
  requesterLabel: string | null,
): SplitResult {
  const itemsByName = new Map(items.map((item) => [item.name, item]));
  const subtotalByLabel = new Map<string, number>();

  for (const assignment of itemAssignments) {
    const item = itemsByName.get(assignment.itemName);
    if (!item) {
      throw new Error(`Assignment references unknown item "${assignment.itemName}"`);
    }
    if (assignment.personLabels.length === 0) {
      throw new Error(`Assignment for "${assignment.itemName}" has no assigned people`);
    }

    const perPersonShare = item.price / assignment.personLabels.length;
    for (const label of assignment.personLabels) {
      subtotalByLabel.set(label, (subtotalByLabel.get(label) ?? 0) + perPersonShare);
    }
  }

  const labels = Array.from(subtotalByLabel.keys());
  const totalItemsAssigned = Array.from(subtotalByLabel.values()).reduce((sum, v) => sum + v, 0);
  const shares: PersonShare[] = [];
  let allocatedTaxTip = 0;

  labels.forEach((label, index) => {
    const itemSubtotal = subtotalByLabel.get(label)!;
    const proportion = totalItemsAssigned > 0 ? itemSubtotal / totalItemsAssigned : 0;
    const isLast = index === labels.length - 1;
    const taxAndTipShare = isLast ? round2(taxAndTip - allocatedTaxTip) : round2(taxAndTip * proportion);
    allocatedTaxTip = round2(allocatedTaxTip + taxAndTipShare);

    shares.push({
      label,
      itemSubtotal: round2(itemSubtotal),
      taxAndTipShare,
      total: round2(itemSubtotal + taxAndTipShare),
    });
  });

  const requesterShare = requesterLabel ? shares.find((s) => s.label === requesterLabel) ?? null : null;

  return { shares, requesterShare };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/split/calculator.test.ts`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/split/calculator.ts src/split/calculator.test.ts package.json
git commit -m "feat(split): add pure even/itemized split calculator"
```

---

### Task 3: Receipt extraction (Gemini vision)

**Files:**
- Create: `src/split/extraction.ts`
- Create: `src/split/extraction.test.ts`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `config` from `../config` (existing, `GOOGLE_API_KEY`), `Currency` from `../types` (existing), `ExtractedReceipt`, `ReceiptItem` from `./types` (Task 1).
- Produces: `extractReceipt(photoBuffer: Buffer, mimeType: string): Promise<ExtractedReceipt>`, `parseGeminiReceiptResponse(rawText: string): ExtractedReceipt`, `class ExtractionError extends Error`

- [ ] **Step 1: Write the failing test**

Create `src/split/extraction.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiReceiptResponse, ExtractionError } from './extraction';

test('parseGeminiReceiptResponse maps a valid receipt JSON response', () => {
  const raw = `Here you go:\n{"merchant": "Ya Kun", "items": [{"name": "Kaya Toast Set", "price": 5.8}, {"name": "Iced Milo", "price": 3.2}], "taxAndTip": 0.9, "total": 9.9, "currency": "SGD"}`;

  const result = parseGeminiReceiptResponse(raw);

  assert.equal(result.merchant, 'Ya Kun');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].name, 'Kaya Toast Set');
  assert.equal(result.taxAndTip, 0.9);
  assert.equal(result.total, 9.9);
  assert.equal(result.currency, 'SGD');
});

test('parseGeminiReceiptResponse defaults merchant to null when blank or missing', () => {
  const raw = `{"merchant": "", "items": [{"name": "Coffee", "price": 4}], "taxAndTip": 0, "total": 4, "currency": "SGD"}`;
  const result = parseGeminiReceiptResponse(raw);
  assert.equal(result.merchant, null);
});

test('parseGeminiReceiptResponse throws ExtractionError on unparseable text', () => {
  assert.throws(() => parseGeminiReceiptResponse('not json at all'), ExtractionError);
});

test('parseGeminiReceiptResponse throws ExtractionError on invalid JSON', () => {
  assert.throws(() => parseGeminiReceiptResponse('{ broken json'), ExtractionError);
});

test('parseGeminiReceiptResponse throws ExtractionError when items is empty', () => {
  assert.throws(
    () => parseGeminiReceiptResponse('{"merchant": null, "items": [], "taxAndTip": 0, "total": 0, "currency": "SGD"}'),
    ExtractionError,
  );
});

test('parseGeminiReceiptResponse throws ExtractionError when an item has a non-positive price', () => {
  const raw = `{"merchant": null, "items": [{"name": "Coffee", "price": 0}], "taxAndTip": 0, "total": 4, "currency": "SGD"}`;
  assert.throws(() => parseGeminiReceiptResponse(raw), ExtractionError);
});

test('parseGeminiReceiptResponse throws ExtractionError on an unrecognized currency', () => {
  const raw = `{"merchant": null, "items": [{"name": "Coffee", "price": 4}], "taxAndTip": 0, "total": 4, "currency": "HKD"}`;
  assert.throws(() => parseGeminiReceiptResponse(raw), ExtractionError);
});

test('parseGeminiReceiptResponse throws ExtractionError on a missing/invalid total', () => {
  const raw = `{"merchant": null, "items": [{"name": "Coffee", "price": 4}], "taxAndTip": 0, "total": 0, "currency": "SGD"}`;
  assert.throws(() => parseGeminiReceiptResponse(raw), ExtractionError);
});

test('extractReceipt surfaces a Gemini/network failure as ExtractionError, not a thrown network error', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { extractReceipt } = await import('./extraction');
    await assert.rejects(() => extractReceipt(Buffer.from('fake jpeg'), 'image/jpeg'), ExtractionError);
  } finally {
    global.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Register the test file and run it to see it fail**

In `package.json`, append `src/split/extraction.test.ts` to the `test` script.

Run: `npx tsx --test src/split/extraction.test.ts`
Expected: FAIL — `Cannot find module './extraction'`.

- [ ] **Step 3: Write `extraction.ts`**

```typescript
/**
 * Extracts line items from a photo of a receipt via Gemini multimodal
 * vision. No rule-based fallback — any failure surfaces as
 * ExtractionError, matching the degrade-don't-guess convention used by
 * src/portfolio/statement-parser.ts.
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';
import { Currency } from '../types';
import { ExtractedReceipt, ReceiptItem } from './types';

export class ExtractionError extends Error {}

const VALID_CURRENCIES = new Set(['SGD', 'MYR', 'USD']);

const SYSTEM_INSTRUCTION = `You are a receipt parser for Pluto AI's bill-splitting feature. You will receive a photo of a restaurant/food receipt. Extract every purchased line item (not tax, not service charge, not tip, not the total) with its price, plus the merchant name if visible, the currency, the sum of any tax/service charge/tip lines, and the final total. Return strict JSON only, matching exactly this shape:
{"merchant": string | null, "items": [{"name": string, "price": number}], "taxAndTip": number, "total": number, "currency": "SGD" | "MYR" | "USD"}
Prices are plain decimal numbers, no currency symbols. If you cannot read the receipt clearly, return {"merchant": null, "items": [], "taxAndTip": 0, "total": 0, "currency": "SGD"}.`;

export function parseGeminiReceiptResponse(rawText: string): ExtractedReceipt {
  const start = rawText.indexOf('{');
  const end = rawText.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new ExtractionError('Gemini returned an unparseable response');
  }

  let parsed: {
    merchant?: string | null;
    items?: unknown[];
    taxAndTip?: unknown;
    total?: unknown;
    currency?: string;
  };
  try {
    parsed = JSON.parse(rawText.slice(start, end + 1));
  } catch {
    throw new ExtractionError('Gemini returned invalid JSON');
  }

  const rawItems = (parsed.items ?? []) as unknown[];
  if (rawItems.length === 0) {
    throw new ExtractionError('No line items found on the receipt — try a clearer photo');
  }

  const items: ReceiptItem[] = rawItems.map((raw, index) => {
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== 'string' || item.name.trim() === '') {
      throw new ExtractionError(`Item ${index} is missing a valid name`);
    }
    if (typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price <= 0) {
      throw new ExtractionError(`Item ${index} (${item.name}) has an invalid price`);
    }
    return { name: item.name, price: item.price };
  });

  if (typeof parsed.taxAndTip !== 'number' || !Number.isFinite(parsed.taxAndTip) || parsed.taxAndTip < 0) {
    throw new ExtractionError('Missing or invalid taxAndTip');
  }
  if (typeof parsed.total !== 'number' || !Number.isFinite(parsed.total) || parsed.total <= 0) {
    throw new ExtractionError('Missing or invalid total');
  }
  if (typeof parsed.currency !== 'string' || !VALID_CURRENCIES.has(parsed.currency)) {
    throw new ExtractionError('Missing or unrecognized currency');
  }

  return {
    merchant: typeof parsed.merchant === 'string' && parsed.merchant.trim() !== '' ? parsed.merchant : null,
    items,
    taxAndTip: parsed.taxAndTip,
    total: parsed.total,
    currency: parsed.currency as Currency,
  };
}

export async function extractReceipt(photoBuffer: Buffer, mimeType: string): Promise<ExtractedReceipt> {
  try {
    const genAI = new GoogleGenerativeAI(config.GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.6-flash',
      systemInstruction: SYSTEM_INSTRUCTION,
    });

    // Vision calls run slower than short text-classification prompts (ai.ts's
    // 15s budget) — 30s gives enough headroom, matching statement-parser.ts.
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Gemini receipt extraction timed out after 30s')), 30000);
    });

    const result = await Promise.race([
      model.generateContent([
        { inlineData: { mimeType, data: photoBuffer.toString('base64') } },
        { text: 'Extract the receipt as instructed and return only the JSON.' },
      ]),
      timeoutPromise,
    ]);

    return parseGeminiReceiptResponse(result.response.text());
  } catch (error) {
    if (error instanceof ExtractionError) {
      throw error;
    }
    throw new ExtractionError(`Gemini receipt extraction failed: ${(error as Error).message}`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/split/extraction.test.ts`
Expected: PASS, all 9 tests green.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/split/extraction.ts src/split/extraction.test.ts package.json
git commit -m "feat(split): add Gemini vision receipt extraction"
```

---

### Task 4: Split instruction parsing (Gemini text)

**Files:**
- Create: `src/split/assignment.ts`
- Create: `src/split/assignment.test.ts`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `config` from `../config` (existing), `ItemAssignment`, `ReceiptItem`, `SplitInstructions` from `./types` (Task 1).
- Produces: `parseSplitInstructions(freeText: string, items: ReceiptItem[]): Promise<SplitInstructions>`, `parseGeminiAssignmentResponse(rawText: string, validItemNames: string[]): SplitInstructions`, `class AssignmentParseError extends Error`

- [ ] **Step 1: Write the failing test**

Create `src/split/assignment.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiAssignmentResponse, AssignmentParseError } from './assignment';

const ITEM_NAMES = ['Burger', 'Salad', 'Fries'];

test('parseGeminiAssignmentResponse maps a valid even-split response', () => {
  const raw = `{"mode": "even", "headcount": 3, "itemAssignments": null, "requesterLabel": "me"}`;
  const result = parseGeminiAssignmentResponse(raw, ITEM_NAMES);

  assert.equal(result.mode, 'even');
  assert.equal(result.headcount, 3);
  assert.equal(result.requesterLabel, 'me');
});

test('parseGeminiAssignmentResponse maps a valid itemized response covering every item', () => {
  const raw = `{"mode": "itemized", "headcount": null, "itemAssignments": [
    {"itemName": "Burger", "personLabels": ["Alice"]},
    {"itemName": "Salad", "personLabels": ["me"]},
    {"itemName": "Fries", "personLabels": ["Alice", "me"]}
  ], "requesterLabel": "me"}`;

  const result = parseGeminiAssignmentResponse(raw, ITEM_NAMES);

  assert.equal(result.mode, 'itemized');
  assert.equal(result.itemAssignments!.length, 3);
  assert.equal(result.requesterLabel, 'me');
});

test('parseGeminiAssignmentResponse throws when mode is neither even nor itemized', () => {
  assert.throws(
    () => parseGeminiAssignmentResponse('{"mode": null}', ITEM_NAMES),
    AssignmentParseError,
  );
});

test('parseGeminiAssignmentResponse throws on unparseable text', () => {
  assert.throws(() => parseGeminiAssignmentResponse('not json', ITEM_NAMES), AssignmentParseError);
});

test('parseGeminiAssignmentResponse throws when even mode is missing a valid headcount', () => {
  assert.throws(
    () => parseGeminiAssignmentResponse('{"mode": "even", "headcount": 0}', ITEM_NAMES),
    AssignmentParseError,
  );
  assert.throws(
    () => parseGeminiAssignmentResponse('{"mode": "even", "headcount": "three"}', ITEM_NAMES),
    AssignmentParseError,
  );
});

test('parseGeminiAssignmentResponse throws when an itemized assignment references an unknown item', () => {
  const raw = `{"mode": "itemized", "itemAssignments": [{"itemName": "Dessert", "personLabels": ["me"]}], "requesterLabel": "me"}`;
  assert.throws(() => parseGeminiAssignmentResponse(raw, ITEM_NAMES), AssignmentParseError);
});

test('parseGeminiAssignmentResponse throws when an itemized split leaves an item unassigned', () => {
  const raw = `{"mode": "itemized", "itemAssignments": [
    {"itemName": "Burger", "personLabels": ["Alice"]},
    {"itemName": "Salad", "personLabels": ["me"]}
  ], "requesterLabel": "me"}`;
  assert.throws(() => parseGeminiAssignmentResponse(raw, ITEM_NAMES), AssignmentParseError);
});

test('parseGeminiAssignmentResponse throws when an assignment has no personLabels', () => {
  const raw = `{"mode": "itemized", "itemAssignments": [
    {"itemName": "Burger", "personLabels": []},
    {"itemName": "Salad", "personLabels": ["me"]},
    {"itemName": "Fries", "personLabels": ["me"]}
  ], "requesterLabel": "me"}`;
  assert.throws(() => parseGeminiAssignmentResponse(raw, ITEM_NAMES), AssignmentParseError);
});

test('parseGeminiAssignmentResponse allows requesterLabel to be null when ambiguous', () => {
  const raw = `{"mode": "even", "headcount": 2, "requesterLabel": null}`;
  const result = parseGeminiAssignmentResponse(raw, ITEM_NAMES);
  assert.equal(result.requesterLabel, null);
});

test('parseSplitInstructions surfaces a Gemini/network failure as AssignmentParseError', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { parseSplitInstructions } = await import('./assignment');
    await assert.rejects(
      () => parseSplitInstructions('split between 2', [{ name: 'Burger', price: 10 }]),
      AssignmentParseError,
    );
  } finally {
    global.fetch = originalFetch;
  }
});
```

- [ ] **Step 2: Register the test file and run it to see it fail**

In `package.json`, append `src/split/assignment.test.ts` to the `test` script.

Run: `npx tsx --test src/split/assignment.test.ts`
Expected: FAIL — `Cannot find module './assignment'`.

- [ ] **Step 3: Write `assignment.ts`**

```typescript
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
    const rawAssignments = (parsed.itemAssignments ?? []) as unknown[];
    if (rawAssignments.length === 0) {
      throw new AssignmentParseError('Itemized split has no item assignments');
    }

    const validNames = new Set(validItemNames);
    const assignedNames = new Set<string>();

    const itemAssignments: ItemAssignment[] = rawAssignments.map((raw, index) => {
      const assignment = raw as Record<string, unknown>;
      if (typeof assignment.itemName !== 'string' || !validNames.has(assignment.itemName)) {
        throw new AssignmentParseError(`Assignment ${index} references an unknown item`);
      }
      const personLabels = assignment.personLabels;
      if (
        !Array.isArray(personLabels) ||
        personLabels.length === 0 ||
        !personLabels.every((l) => typeof l === 'string')
      ) {
        throw new AssignmentParseError(`Assignment ${index} (${assignment.itemName}) has no valid people assigned`);
      }
      assignedNames.add(assignment.itemName as string);
      return { itemName: assignment.itemName as string, personLabels: personLabels as string[] };
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/split/assignment.test.ts`
Expected: PASS, all 10 tests green.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/split/assignment.ts src/split/assignment.test.ts package.json
git commit -m "feat(split): add Gemini split-instruction parsing"
```

---

### Task 5: In-memory conversation state

**Files:**
- Create: `src/split/state.ts`
- Create: `src/split/state.test.ts`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `ExtractedReceipt`, `SplitResult`, `SplitStage`, `SplitState` from `./types` (Task 1).
- Produces: `startSplit(chatId: number): void`, `getSplitState(chatId: number): SplitState | undefined`, `setReceipt(chatId: number, receipt: ExtractedReceipt): void`, `setPendingResult(chatId: number, result: SplitResult): void`, `clearSplit(chatId: number): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/split/state.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startSplit,
  getSplitState,
  setReceipt,
  setPendingResult,
  clearSplit,
} from './state';
import { ExtractedReceipt, SplitResult } from './types';

function fakeReceipt(): ExtractedReceipt {
  return { merchant: 'Test Cafe', items: [{ name: 'Coffee', price: 4 }], taxAndTip: 0, total: 4, currency: 'SGD' };
}

function fakeResult(): SplitResult {
  const share = { label: 'You', itemSubtotal: 4, taxAndTipShare: 0, total: 4 };
  return { shares: [share], requesterShare: share };
}

test('startSplit puts a chat into awaiting_photo', () => {
  startSplit(1001);
  assert.deepEqual(getSplitState(1001), { stage: 'awaiting_photo' });
});

test('getSplitState returns undefined for a chat with no active split', () => {
  assert.equal(getSplitState(999999), undefined);
});

test('setReceipt transitions to awaiting_instructions and stores the receipt', () => {
  startSplit(1002);
  setReceipt(1002, fakeReceipt());

  const state = getSplitState(1002);
  assert.equal(state?.stage, 'awaiting_instructions');
  assert.deepEqual(state?.receipt, fakeReceipt());
});

test('setReceipt throws when there is no active split for that chat', () => {
  assert.throws(() => setReceipt(1003, fakeReceipt()));
});

test('setPendingResult transitions to awaiting_log_confirmation and stores the result', () => {
  startSplit(1004);
  setReceipt(1004, fakeReceipt());
  setPendingResult(1004, fakeResult());

  const state = getSplitState(1004);
  assert.equal(state?.stage, 'awaiting_log_confirmation');
  assert.deepEqual(state?.pendingResult, fakeResult());
  // receipt from the earlier stage is preserved, not dropped
  assert.deepEqual(state?.receipt, fakeReceipt());
});

test('setPendingResult throws when there is no active split for that chat', () => {
  assert.throws(() => setPendingResult(1005, fakeResult()));
});

test('clearSplit removes state and returns whether something was cleared', () => {
  startSplit(1006);
  assert.equal(clearSplit(1006), true);
  assert.equal(getSplitState(1006), undefined);
  assert.equal(clearSplit(1006), false);
});

test('state for one chat never affects another chat', () => {
  startSplit(2001);
  startSplit(2002);
  setReceipt(2001, fakeReceipt());

  assert.equal(getSplitState(2001)?.stage, 'awaiting_instructions');
  assert.equal(getSplitState(2002)?.stage, 'awaiting_photo');
});
```

- [ ] **Step 2: Register the test file and run it to see it fail**

In `package.json`, append `src/split/state.test.ts` to the `test` script.

Run: `npx tsx --test src/split/state.test.ts`
Expected: FAIL — `Cannot find module './state'`.

- [ ] **Step 3: Write `state.ts`**

```typescript
/**
 * In-memory per-chat state for the /split flow. Not persisted — a bot
 * restart mid-flow loses it; the user just runs /split again. Fine for
 * a handful of messages exchanged in quick succession (see the spec's
 * rationale for not using a DB-backed pending-state table here).
 */

import { ExtractedReceipt, SplitResult, SplitState } from './types';

const state = new Map<number, SplitState>();

export function startSplit(chatId: number): void {
  state.set(chatId, { stage: 'awaiting_photo' });
}

export function getSplitState(chatId: number): SplitState | undefined {
  return state.get(chatId);
}

export function setReceipt(chatId: number, receipt: ExtractedReceipt): void {
  const current = state.get(chatId);
  if (!current) {
    throw new Error(`No active split for chat ${chatId}`);
  }
  state.set(chatId, { ...current, stage: 'awaiting_instructions', receipt });
}

export function setPendingResult(chatId: number, result: SplitResult): void {
  const current = state.get(chatId);
  if (!current) {
    throw new Error(`No active split for chat ${chatId}`);
  }
  state.set(chatId, { ...current, stage: 'awaiting_log_confirmation', pendingResult: result });
}

export function clearSplit(chatId: number): boolean {
  return state.delete(chatId);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/split/state.test.ts`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/split/state.ts src/split/state.test.ts package.json
git commit -m "feat(split): add in-memory per-chat split state"
```

---

### Task 6: Bot flow orchestration

**Files:**
- Create: `src/bot/commands/split.ts`
- Create: `src/bot/commands/split.test.ts`
- Modify: `package.json` (test script)

**Interfaces:**
- Consumes: `logExpense` from `../../expense` (existing — `logExpense(data: ExpenseInput): Promise<Transaction>`), `formatCurrency` from `../../config` (existing), `extractReceipt`/`ExtractionError` from `../../split/extraction` (Task 3), `parseSplitInstructions`/`AssignmentParseError` from `../../split/assignment` (Task 4), `calculateEvenSplit`/`calculateItemizedSplit` from `../../split/calculator` (Task 2), `startSplit`/`getSplitState`/`setReceipt`/`setPendingResult`/`clearSplit` from `../../split/state` (Task 5), `PersonShare`/`SplitResult` from `../../split/types` (Task 1).
- Produces: `handleSplitCommand(chatId: number): string`, `handleCancelCommand(chatId: number): string`, `handleSplitPhoto(chatId: number, photoBuffer: Buffer, mimeType: string): Promise<string>`, `handleSplitTextMessage(chatId: number, message: string): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `src/bot/commands/split.test.ts`:

```typescript
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-split-command.db';

const testDbPath = path.resolve('./data/test-split-command.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  runMigrations();
});

/**
 * Queues canned Gemini text responses in call order, regardless of which
 * Gemini call site makes the request — simpler than content-sniffing since
 * this orchestration layer's tests care about sequencing, not prompt
 * content (extraction.ts/assignment.ts/categorizer.ts already have their
 * own dedicated prompt-parsing tests).
 */
function stubGeminiSequence(responses: string[]): () => void {
  const originalFetch = global.fetch;
  let callIndex = 0;

  global.fetch = (async () => {
    const text = responses[Math.min(callIndex, responses.length - 1)];
    callIndex += 1;
    const body = JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  return () => {
    global.fetch = originalFetch;
  };
}

const EVEN_SPLIT_RESPONSE = JSON.stringify({
  mode: 'even',
  headcount: 2,
  itemAssignments: null,
  requesterLabel: 'me',
});

const CATEGORY_RESPONSE = JSON.stringify({ category: 'Food', confidence: 0.9 });

test('handleSplitCommand starts a split and asks for a photo', async () => {
  const { handleSplitCommand } = await import('./split');
  const { getSplitState } = await import('../../split/state');

  const reply = handleSplitCommand(3001);

  assert.match(reply, /photo/i);
  assert.equal(getSplitState(3001)?.stage, 'awaiting_photo');
});

test('handleCancelCommand clears an active split and reports nothing to cancel otherwise', async () => {
  const { handleSplitCommand, handleCancelCommand } = await import('./split');
  const { getSplitState } = await import('../../split/state');

  handleSplitCommand(3002);
  assert.match(handleCancelCommand(3002), /cancelled/i);
  assert.equal(getSplitState(3002), undefined);

  assert.match(handleCancelCommand(3002), /nothing to cancel/i);
});

test('handleSplitPhoto without an active split hints at /split instead of calling Gemini', async () => {
  const { handleSplitPhoto } = await import('./split');
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = (async () => {
    fetchCalled = true;
    throw new Error('should not be called');
  }) as typeof fetch;

  try {
    const reply = await handleSplitPhoto(3003, Buffer.from('fake jpeg'), 'image/jpeg');
    assert.match(reply, /split/i);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleSplitPhoto extracts a receipt and moves to awaiting_instructions', async () => {
  const { handleSplitCommand, handleSplitPhoto } = await import('./split');
  const { getSplitState } = await import('../../split/state');

  handleSplitCommand(3004);
  const receiptResponse = JSON.stringify({
    merchant: 'Ya Kun',
    items: [
      { name: 'Kaya Toast', price: 5 },
      { name: 'Iced Milo', price: 5 },
    ],
    taxAndTip: 0,
    total: 10,
    currency: 'SGD',
  });
  const restore = stubGeminiSequence([receiptResponse]);

  try {
    const reply = await handleSplitPhoto(3004, Buffer.from('fake jpeg'), 'image/jpeg');
    assert.match(reply, /Ya Kun/);
    assert.equal(getSplitState(3004)?.stage, 'awaiting_instructions');
  } finally {
    restore();
  }
});

test('handleSplitPhoto keeps the flow at awaiting_photo and replies with an error when extraction fails', async () => {
  const { handleSplitCommand, handleSplitPhoto } = await import('./split');
  const { getSplitState } = await import('../../split/state');

  handleSplitCommand(3005);
  const restore = stubGeminiSequence(['not valid json']);

  try {
    const reply = await handleSplitPhoto(3005, Buffer.from('fake jpeg'), 'image/jpeg');
    assert.match(reply, /couldn't read/i);
    assert.equal(getSplitState(3005)?.stage, 'awaiting_photo');
  } finally {
    restore();
  }
});

test('handleSplitTextMessage: even split then Yes logs only the requester share', async () => {
  const { handleSplitCommand, handleSplitPhoto, handleSplitTextMessage } = await import('./split');
  const { getSplitState } = await import('../../split/state');
  const { getSpendingSummary } = await import('../../expense');

  handleSplitCommand(3006);
  const receiptResponse = JSON.stringify({
    merchant: 'Test Cafe',
    items: [{ name: 'Meal', price: 20 }],
    taxAndTip: 0,
    total: 20,
    currency: 'SGD',
  });

  let restore = stubGeminiSequence([receiptResponse]);
  await handleSplitPhoto(3006, Buffer.from('fake jpeg'), 'image/jpeg');
  restore();

  restore = stubGeminiSequence([EVEN_SPLIT_RESPONSE]);
  const breakdownReply = await handleSplitTextMessage(3006, 'split between 2');
  restore();

  assert.match(breakdownReply, /You: S\$10\.00/);
  assert.match(breakdownReply, /Log your share/i);
  assert.equal(getSplitState(3006)?.stage, 'awaiting_log_confirmation');

  const before = await getSpendingSummary('today');

  restore = stubGeminiSequence([CATEGORY_RESPONSE]);
  const logReply = await handleSplitTextMessage(3006, 'yes');
  restore();

  assert.match(logReply, /Logged S\$10\.00/);
  assert.equal(getSplitState(3006), undefined);

  const after = await getSpendingSummary('today');
  assert.equal(after.total - before.total, 1000); // 10.00 SGD in cents, only the requester's share
  assert.equal(after.count - before.count, 1);
});

test('handleSplitTextMessage: No logs nothing and clears state', async () => {
  const { handleSplitCommand, handleSplitPhoto, handleSplitTextMessage } = await import('./split');
  const { getSplitState } = await import('../../split/state');
  const { getSpendingSummary } = await import('../../expense');

  handleSplitCommand(3007);
  const receiptResponse = JSON.stringify({
    merchant: 'Test Cafe',
    items: [{ name: 'Meal', price: 20 }],
    taxAndTip: 0,
    total: 20,
    currency: 'SGD',
  });

  let restore = stubGeminiSequence([receiptResponse]);
  await handleSplitPhoto(3007, Buffer.from('fake jpeg'), 'image/jpeg');
  restore();

  restore = stubGeminiSequence([EVEN_SPLIT_RESPONSE]);
  await handleSplitTextMessage(3007, 'split between 2');
  restore();

  const before = await getSpendingSummary('today');
  const reply = await handleSplitTextMessage(3007, 'no');
  const after = await getSpendingSummary('today');

  assert.match(reply, /nothing logged/i);
  assert.equal(getSplitState(3007), undefined);
  assert.equal(after.total, before.total);
  assert.equal(after.count, before.count);
});

test('handleSplitTextMessage asks for clarification when the requester share is ambiguous, without advancing the stage', async () => {
  // Note: this only applies to itemized mode. calculateEvenSplit always
  // treats the first share ("You") as the requester by construction, so an
  // even split can never produce a null requesterShare — see calculator.ts.
  const { handleSplitCommand, handleSplitPhoto, handleSplitTextMessage } = await import('./split');
  const { getSplitState } = await import('../../split/state');

  handleSplitCommand(3008);
  const receiptResponse = JSON.stringify({
    merchant: 'Test Cafe',
    items: [{ name: 'Meal', price: 20 }],
    taxAndTip: 0,
    total: 20,
    currency: 'SGD',
  });

  let restore = stubGeminiSequence([receiptResponse]);
  await handleSplitPhoto(3008, Buffer.from('fake jpeg'), 'image/jpeg');
  restore();

  // Itemized, but requesterLabel is null (Gemini couldn't tell who "you" is)
  // and the only assigned label is "Alice" — calculateItemizedSplit has no
  // share to match a null/absent requesterLabel against, so requesterShare
  // comes back null.
  const ambiguousResponse = JSON.stringify({
    mode: 'itemized',
    itemAssignments: [{ itemName: 'Meal', personLabels: ['Alice'] }],
    requesterLabel: null,
  });
  restore = stubGeminiSequence([ambiguousResponse]);

  try {
    const reply = await handleSplitTextMessage(3008, 'Alice had the meal');
    assert.match(reply, /which share is yours/i);
    assert.equal(getSplitState(3008)?.stage, 'awaiting_instructions');
  } finally {
    restore();
  }
});
```

- [ ] **Step 2: Register the test file and run it to see it fail**

In `package.json`, append `src/bot/commands/split.test.ts` to the `test` script.

Run: `npx tsx --test src/bot/commands/split.test.ts`
Expected: FAIL — `Cannot find module './split'`.

- [ ] **Step 3: Write `split.ts`**

```typescript
/**
 * /split flow orchestration: receipt photo -> even/itemized split ->
 * optional logging of the requester's own share only. See
 * docs/tasks/08-expense-split.md.
 */

import { logger } from '../../utils/logger';
import { logExpense } from '../../expense';
import { extractReceipt, ExtractionError } from '../../split/extraction';
import { parseSplitInstructions, AssignmentParseError } from '../../split/assignment';
import { calculateEvenSplit, calculateItemizedSplit } from '../../split/calculator';
import { clearSplit, getSplitState, setPendingResult, setReceipt, startSplit } from '../../split/state';
import { formatCurrency } from '../../config';
import { Currency } from '../../types';
import { PersonShare, SplitResult } from '../../split/types';

function formatBreakdown(result: SplitResult, currency: Currency): string {
  return result.shares
    .map((share: PersonShare) => `${share.label}: ${formatCurrency(Math.round(share.total * 100), currency)}`)
    .join('\n');
}

export function handleSplitCommand(chatId: number): string {
  startSplit(chatId);
  return 'Send me a photo of the receipt to split.';
}

export function handleCancelCommand(chatId: number): string {
  return clearSplit(chatId) ? 'Split cancelled.' : 'Nothing to cancel.';
}

export async function handleSplitPhoto(chatId: number, photoBuffer: Buffer, mimeType: string): Promise<string> {
  const state = getSplitState(chatId);
  if (!state || state.stage !== 'awaiting_photo') {
    return 'Got a photo — if you want to split a bill, run /split first.';
  }

  try {
    const receipt = await extractReceipt(photoBuffer, mimeType);
    setReceipt(chatId, receipt);
    return `Got it${receipt.merchant ? ` — ${receipt.merchant}` : ''}. Should I split it evenly, or tell me who had what?`;
  } catch (error) {
    if (error instanceof ExtractionError) {
      logger.warn('Receipt extraction failed', { message: error.message });
      return `I couldn't read that receipt (${error.message}). Try a clearer photo.`;
    }
    throw error;
  }
}

export async function handleSplitTextMessage(chatId: number, message: string): Promise<string> {
  const state = getSplitState(chatId);
  if (!state) {
    throw new Error(`handleSplitTextMessage called with no active split for chat ${chatId}`);
  }

  if (state.stage === 'awaiting_instructions') {
    if (!state.receipt) {
      throw new Error(`Split for chat ${chatId} is awaiting_instructions with no receipt`);
    }
    const receipt = state.receipt;

    try {
      const instructions = await parseSplitInstructions(message, receipt.items);
      const result =
        instructions.mode === 'even'
          ? calculateEvenSplit(receipt.total, instructions.headcount!)
          : calculateItemizedSplit(
              receipt.items,
              receipt.taxAndTip,
              instructions.itemAssignments!,
              instructions.requesterLabel,
            );

      if (!result.requesterShare) {
        return 'I couldn\'t tell which share is yours — mention yourself as "I" or "me" and try again.';
      }

      setPendingResult(chatId, result);
      const breakdown = formatBreakdown(result, receipt.currency);
      const shareCents = Math.round(result.requesterShare.total * 100);
      return `${breakdown}\n\nLog your share of ${formatCurrency(
        shareCents,
        receipt.currency,
      )} as an expense? (skip if it's already logged some other way, e.g. Apple Pay) Yes/No`;
    } catch (error) {
      if (error instanceof AssignmentParseError) {
        logger.warn('Split instruction parsing failed', { message: error.message });
        return `I couldn't work that out (${error.message}). Try again — e.g. "split between 3" or "Alice had the burger, I had the salad".`;
      }
      throw error;
    }
  }

  if (state.stage === 'awaiting_log_confirmation') {
    const confirmed = /^\s*y(es)?\s*$/i.test(message);
    const declined = /^\s*no?\s*$/i.test(message);

    if (!confirmed && !declined) {
      return 'Reply Yes to log your share, or No to skip.';
    }

    const pendingResult = state.pendingResult;
    if (!pendingResult || !pendingResult.requesterShare) {
      throw new Error(`Split for chat ${chatId} is awaiting_log_confirmation with no pending result`);
    }
    const receipt = state.receipt;

    clearSplit(chatId);

    if (declined) {
      return 'Okay, nothing logged.';
    }

    const merchant = receipt?.merchant ?? 'Split bill';
    const transaction = await logExpense({
      amount: pendingResult.requesterShare.total,
      currency: receipt?.currency,
      merchant,
      note: 'Split bill',
      source: 'split',
    });

    return `Logged ${formatCurrency(transaction.amount_sgd, 'SGD')} for ${transaction.merchant} (${transaction.category}).`;
  }

  throw new Error(`Unexpected split stage "${state.stage}" for chat ${chatId}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/bot/commands/split.test.ts`
Expected: PASS, all 8 tests green.

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/split.ts src/bot/commands/split.test.ts package.json
git commit -m "feat(split): add /split flow orchestration"
```

---

### Task 7: Wire into the Telegram bot

**Files:**
- Modify: `src/bot/index.ts`
- Modify: `src/bot/formatter/messages.ts`
- Modify: `docs/tasks/08-expense-split.md` (check off completed acceptance criteria)

**Interfaces:**
- Consumes: `handleSplitCommand`, `handleCancelCommand`, `handleSplitPhoto`, `handleSplitTextMessage` from `./commands/split` (Task 6), `getSplitState` from `../split/state` (Task 5).

This task has no new automated test of its own — `bot/index.ts` wires a real `grammy.Bot` instance and isn't unit-tested anywhere in this codebase (the existing `message:document` wiring follows the same precedent: `handleDocumentMessage` is tested directly, the wiring around it is not). Verification here is `npm test` (no regressions) plus the manual smoke check in Step 4.

- [ ] **Step 1: Add `/split` to the help message**

In `src/bot/formatter/messages.ts`, in `formatHelpMessage`, add a line after `/undo`:

```typescript
export function formatHelpMessage(): string {
  return formatLines('Plutus commands', [
    '/portfolio - quick portfolio check',
    '/today - today\'s spend',
    '/month - monthly breakdown',
    '/budget - budget status',
    '/export - export your data',
    '/undo - undo the last transaction',
    '/split - split a bill from a receipt photo',
    '/digest - preview tonight\'s digest',
    '/help - this menu',
    '',
    'Or just message me naturally, like “Spent $4.50 at Ya Kun”.',
  ]);
}
```

- [ ] **Step 2: Wire the split flow into `src/bot/index.ts`**

Add the import alongside the other handler imports:

```typescript
import { handleSplitCommand, handleCancelCommand, handleSplitPhoto, handleSplitTextMessage } from './commands/split';
import { getSplitState } from '../split/state';
```

Add the `/split` and `/cancel` commands (anywhere alongside the other `this.bot.command(...)` registrations, before `this.bot.command('start', ...)`):

```typescript
    this.bot.command('split', async (ctx) => {
      const response = handleSplitCommand(ctx.chat.id);
      await this.replyWithText(ctx, response);
    });

    this.bot.command('cancel', async (ctx) => {
      const response = handleCancelCommand(ctx.chat.id);
      await this.replyWithText(ctx, response);
    });
```

Replace the existing `message:text` handler so an active split intercepts before normal classification:

```typescript
    this.bot.on('message:text', async (ctx) => {
      if (getSplitState(ctx.chat.id)) {
        const response = await handleSplitTextMessage(ctx.chat.id, ctx.message.text);
        await this.replyWithText(ctx, response);
        return;
      }
      const response = await handleTextMessage(ctx.message.text);
      await this.replyWithText(ctx, response);
    });
```

Add a `message:photo` handler (alongside the existing `message:document` handler), downloading the largest available resolution the same way `message:document` downloads its file:

```typescript
    this.bot.on('message:photo', async (ctx) => {
      const photos = ctx.message.photo;
      if (!photos || photos.length === 0) {
        return;
      }
      const largest = photos[photos.length - 1];
      const file = await ctx.api.getFile(largest.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      const reply = await handleSplitPhoto(ctx.chat.id, buffer, 'image/jpeg');
      await this.replyWithText(ctx, reply);
    });
```

(Telegram's `photo` field is always a compressed JPEG regardless of the original file type, unlike `document`, so the mime type is hardcoded here rather than read from the update.)

- [ ] **Step 3: Type-check and run the full suite**

Run: `npx tsc --noEmit`
Expected: no new errors.

Run: `npm test`
Expected: PASS, no regressions.

- [ ] **Step 4: Manual smoke check**

Run: `npm run dev` with a real `TELEGRAM_BOT_TOKEN` and `GOOGLE_API_KEY` configured. In the authorized Telegram chat:
1. Send `/split` — expect a request for a photo.
2. Send a photo of any itemized receipt — expect a breakdown-style acknowledgement naming the merchant (or a "couldn't read that" reply if extraction fails — try a clearer photo).
3. Reply `split between 2` — expect a two-person breakdown ending in a Yes/No logging prompt.
4. Reply `yes` — expect a "Logged ..." confirmation, and verify via `/today` that exactly one new transaction appeared for the requester's share only (not the full bill).
5. Repeat from step 1 and reply `no` at the confirmation — verify via `/today` that no new transaction was created.
6. Repeat from step 1, and send `/cancel` after step 2 — expect a "Split cancelled." reply and that sending a normal text message afterward is classified normally (not swallowed by the split flow).

- [ ] **Step 5: Check off completed acceptance criteria**

In `docs/tasks/08-expense-split.md`, mark every item in **Acceptance Criteria** as `[x]` and add a `**Status: implemented.**` line at the top of that section, matching the convention used in `docs/tasks/07-ios-shortcut-integration.md`.

- [ ] **Step 6: Commit**

```bash
git add src/bot/index.ts src/bot/formatter/messages.ts docs/tasks/08-expense-split.md
git commit -m "feat(split): wire /split flow into the Telegram bot"
```

---

## Self-Review Notes

- **Spec coverage**: every acceptance criterion in `docs/tasks/08-expense-split.md` maps to a task above — trigger (Task 7), extraction failure handling (Task 3/6), even/itemized modes and proportional tax/tip (Task 2/4/6), ambiguous self-identification (Task 6), Yes/No logging with the Apple-Pay-double-count hint (Task 6/7), `/cancel` (Task 5/6/7), no persistence of other participants (Task 6 — only `requesterShare` ever reaches `logExpense`), stale-state-not-resumed (Task 5, in-memory by design).
- **Type consistency checked**: `SplitResult`/`PersonShare`/`SplitInstructions`/`ExtractedReceipt`/`ItemAssignment` (Task 1) are used with identical field names across `calculator.ts` (Task 2), `extraction.ts` (Task 3), `assignment.ts` (Task 4), `state.ts` (Task 5), and `split.ts` (Task 6) — no renamed fields between tasks.
- **No placeholders**: every step above has runnable code, not a description of code.
