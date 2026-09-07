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
