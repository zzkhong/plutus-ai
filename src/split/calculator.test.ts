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

test('calculateItemizedSplit guarantees an exact-cent sum even when item-subtotal rounding alone would drift', () => {
  const result = calculateItemizedSplit(
    [{ name: 'Shared Item', price: 10 }],
    0,
    [{ itemName: 'Shared Item', personLabels: ['A', 'B', 'C'] }],
    'A',
  );

  const sum = result.shares.reduce((acc, s) => acc + s.total, 0);
  assert.equal(sum, 10);
  // every share.total must equal itemSubtotal + taxAndTipShare exactly, including the last
  for (const share of result.shares) {
    assert.equal(share.total, Math.round((share.itemSubtotal + share.taxAndTipShare) * 100) / 100);
  }
});
