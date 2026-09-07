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
  let allocatedItemSubtotal = 0;
  let allocatedTaxTip = 0;

  labels.forEach((label, index) => {
    const rawItemSubtotal = subtotalByLabel.get(label)!;
    const proportion = totalItemsAssigned > 0 ? rawItemSubtotal / totalItemsAssigned : 0;
    const isLast = index === labels.length - 1;

    const itemSubtotal = isLast
      ? round2(totalItemsAssigned - allocatedItemSubtotal)
      : round2(rawItemSubtotal);
    allocatedItemSubtotal = round2(allocatedItemSubtotal + itemSubtotal);

    const taxAndTipShare = isLast ? round2(taxAndTip - allocatedTaxTip) : round2(taxAndTip * proportion);
    allocatedTaxTip = round2(allocatedTaxTip + taxAndTipShare);

    shares.push({
      label,
      itemSubtotal,
      taxAndTipShare,
      total: round2(itemSubtotal + taxAndTipShare),
    });
  });

  const requesterShare = requesterLabel ? shares.find((s) => s.label === requesterLabel) ?? null : null;

  return { shares, requesterShare };
}
