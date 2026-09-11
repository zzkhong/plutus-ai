import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-split-assignment.db';

const testDbPath = path.resolve('./data/test-split-assignment.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

// assignment.ts now imports ../users/service -> ../db (client.ts), whose
// module-level `export const db = getDb()` eagerly opens/migrates a
// connection using config.DATABASE_URL at *import* time. tsx/esbuild hoists
// static imports above all other top-level code regardless of source
// position, so a static top-level `import ... from './assignment'` would
// still resolve before the process.env.DATABASE_URL assignment above runs
// and silently connect to the real dev ./data/pluto.db instead of this
// test's db. Importing dynamically inside before() (which runs after the
// assignment) avoids that.
type AssignmentModule = typeof import('./assignment');
let parseGeminiAssignmentResponse: AssignmentModule['parseGeminiAssignmentResponse'];
let AssignmentParseError: AssignmentModule['AssignmentParseError'];
let userId: string;

before(async () => {
  const { runMigrations } = await import('../db/migrate');
  await runMigrations();
  const { createUser, setProvider, completeSetup } = await import('../users/service');
  const { encrypt } = await import('../users/crypto');
  const user = await createUser('test-split-assignment-chat');
  await setProvider(user.id, 'gemini');
  await completeSetup(user.id, encrypt('fake-key-for-tests'), true);
  userId = user.id;

  const assignmentModule = await import('./assignment');
  parseGeminiAssignmentResponse = assignmentModule.parseGeminiAssignmentResponse;
  AssignmentParseError = assignmentModule.AssignmentParseError;
});

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

test('parseGeminiAssignmentResponse throws when the same item is assigned more than once', () => {
  const raw = `{"mode": "itemized", "itemAssignments": [
    {"itemName": "Burger", "personLabels": ["Alice"]},
    {"itemName": "Burger", "personLabels": ["Bob"]},
    {"itemName": "Salad", "personLabels": ["me"]},
    {"itemName": "Fries", "personLabels": ["me"]}
  ], "requesterLabel": "me"}`;
  assert.throws(() => parseGeminiAssignmentResponse(raw, ITEM_NAMES), AssignmentParseError);
});

test('parseGeminiAssignmentResponse throws AssignmentParseError (not a raw TypeError) when itemAssignments is not an array', () => {
  const raw = `{"mode": "itemized", "itemAssignments": {}, "requesterLabel": "me"}`;
  assert.throws(() => parseGeminiAssignmentResponse(raw, ITEM_NAMES), AssignmentParseError);
});

test('parseGeminiAssignmentResponse throws AssignmentParseError (not a raw TypeError) when an assignment element is null', () => {
  const raw = `{"mode": "itemized", "itemAssignments": [null], "requesterLabel": "me"}`;
  assert.throws(() => parseGeminiAssignmentResponse(raw, ITEM_NAMES), AssignmentParseError);
});

test('parseSplitInstructions surfaces a Gemini/network failure as AssignmentParseError', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { parseSplitInstructions } = await import('./assignment');
    await assert.rejects(
      () => parseSplitInstructions(userId, 'split between 2', [{ name: 'Burger', price: 10 }]),
      AssignmentParseError,
    );
  } finally {
    global.fetch = originalFetch;
  }
});
