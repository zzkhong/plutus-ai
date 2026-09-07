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
