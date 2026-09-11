import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWebhookKeyCommand } from './webhookkey';
import { User } from '../../users/types';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    telegram_chat_id: '12345',
    status: 'approved',
    is_admin: false,
    llm_provider: 'gemini',
    llm_api_key_encrypted: 'encrypted',
    webhook_api_key: 'abc-123-webhook-key',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

test('handleWebhookKeyCommand returns the caller own webhook key', async () => {
  const reply = await handleWebhookKeyCommand(makeUser());
  assert.match(reply, /abc-123-webhook-key/);
  assert.match(reply, /x-api-key/);
});

test('handleWebhookKeyCommand tells a user with no key to finish setup', async () => {
  const reply = await handleWebhookKeyCommand(makeUser({ webhook_api_key: null }));
  assert.match(reply, /finish \/setup/i);
  assert.doesNotMatch(reply, /x-api-key/);
});
