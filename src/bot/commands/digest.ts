/**
 * /digest command handler — manually preview tonight's digest.
 */

import { buildDigestMessage } from '../../digest';

export async function handleDigestCommand(userId: string): Promise<string> {
  return buildDigestMessage(userId);
}
