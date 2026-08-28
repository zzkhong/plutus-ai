/**
 * /digest command handler — manually preview tonight's digest.
 */

import { buildDigestMessage } from '../../digest';

export async function handleDigestCommand(): Promise<string> {
  return buildDigestMessage();
}
