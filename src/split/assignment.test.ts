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
