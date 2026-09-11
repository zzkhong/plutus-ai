/**
 * /webhookkey — shows the calling user their own iOS Shortcut webhook API
 * key. The key is generated when they complete /setup but is never pushed
 * to them unprompted; this is how they retrieve it for the Shortcut's
 * x-api-key header (see docs/setup/ios-shortcut-setup.md).
 */

import { User } from '../../users/types';

export async function handleWebhookKeyCommand(user: User): Promise<string> {
  if (!user.webhook_api_key) {
    return 'You do not have a webhook key yet — finish /setup first.';
  }

  return [
    'Your personal iOS Shortcut webhook key:',
    '',
    user.webhook_api_key,
    '',
    'Send it as the x-api-key header on POST /api/apple-pay.',
    'Treat it like a password — anyone holding it can log expenses as you.',
  ].join('\n');
}
