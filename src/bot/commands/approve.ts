/**
 * /approve and /reject — admin-only commands to gate new signups.
 */

import { approve, findByChatId, reject } from '../../users/service';
import { User } from '../../users/types';

export interface AdminActionResult {
  reply: string;
  notifyChatId?: string;
  notifyMessage?: string;
}

export async function handleApproveCommand(caller: User, targetChatId: string): Promise<AdminActionResult> {
  if (!caller.is_admin) {
    return { reply: 'Only the admin can do that.' };
  }
  if (!targetChatId.trim()) {
    return { reply: 'Usage: /approve <chat_id>' };
  }

  const target = await findByChatId(targetChatId.trim());
  if (!target) {
    return { reply: `No pending user found for chat ${targetChatId}.` };
  }

  await approve(target.id);
  return {
    reply: `Approved ${targetChatId}.`,
    notifyChatId: targetChatId,
    notifyMessage: "You're approved! Try /help to get started.",
  };
}

export async function handleRejectCommand(caller: User, targetChatId: string): Promise<AdminActionResult> {
  if (!caller.is_admin) {
    return { reply: 'Only the admin can do that.' };
  }
  if (!targetChatId.trim()) {
    return { reply: 'Usage: /reject <chat_id>' };
  }

  const target = await findByChatId(targetChatId.trim());
  if (!target) {
    return { reply: `No pending user found for chat ${targetChatId}.` };
  }

  await reject(target.id);
  return {
    reply: `Rejected ${targetChatId}.`,
    notifyChatId: targetChatId,
    notifyMessage: 'Your access request was declined.',
  };
}
