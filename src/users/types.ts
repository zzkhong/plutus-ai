/**
 * Users module types
 */

export type UserStatus = 'onboarding' | 'pending_approval' | 'approved';

// One provider today ('gemini') — widened in a later slice.
export type LLMProviderName = 'gemini';

export interface User {
  id: string;
  telegram_chat_id: string;
  status: UserStatus;
  is_admin: boolean;
  llm_provider: LLMProviderName | null;
  llm_api_key_encrypted: string | null;
  webhook_api_key: string | null;
  created_at: Date;
  updated_at: Date;
}
