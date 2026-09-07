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
