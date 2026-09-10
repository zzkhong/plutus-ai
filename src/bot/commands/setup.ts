/**
 * /setup flow: pick a provider (gemini only this slice) -> paste an API key
 * -> live-validate it -> pending admin approval (or auto-approved for
 * ADMIN_CHAT_ID). State lives entirely on the users row — see
 * authMiddleware for how status='onboarding' routes free text here instead
 * of classification.
 */

import { config } from '../../config';
import { encrypt } from '../../users/crypto';
import {
  completeSetup,
  createUser,
  findByChatId,
  restartOnboarding,
  setProvider,
} from '../../users/service';
import { User } from '../../users/types';
import { GeminiProvider } from '../../llm/gemini';

const SUPPORTED_PROVIDERS = new Set(['gemini']);

export interface SetupTextResult {
  reply: string;
  /** Set when a non-admin chat just completed setup and needs admin approval. */
  notifyAdminForChatId?: string;
}

export async function handleSetupCommand(telegramChatId: string): Promise<string> {
  const existing = await findByChatId(telegramChatId);

  if (!existing) {
    await createUser(telegramChatId);
  } else {
    await restartOnboarding(existing.id);
  }

  return 'Welcome to Pluto AI! Which LLM provider would you like to use? Reply with: gemini';
}

async function validateApiKey(apiKey: string): Promise<boolean> {
  try {
    await new GeminiProvider(apiKey).generateText({
      systemInstruction: 'You are a health check.',
      contents: [{ text: 'Reply with OK.' }],
      timeoutMs: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

export async function handleSetupTextMessage(user: User, text: string): Promise<SetupTextResult> {
  const trimmed = text.trim();

  if (!user.llm_provider) {
    const providerName = trimmed.toLowerCase();
    if (!SUPPORTED_PROVIDERS.has(providerName)) {
      return { reply: `That provider is not available yet — reply "gemini" for now.` };
    }
    await setProvider(user.id, 'gemini');
    return {
      reply:
        "Got it — now send me your Gemini API key (get one at https://aistudio.google.com/apikey). I'll delete your message right after.",
    };
  }

  const isValid = await validateApiKey(trimmed);
  if (!isValid) {
    return { reply: "That key didn't work — the provider rejected it. Please resend a valid API key." };
  }

  const isAdmin = config.ADMIN_CHAT_ID !== undefined && user.telegram_chat_id === config.ADMIN_CHAT_ID;
  const wasAlreadyApproved = user.llm_api_key_encrypted !== null; // rotation, not a first-time signup
  const completed = await completeSetup(user.id, encrypt(trimmed), isAdmin);

  if (completed.status === 'pending_approval') {
    return {
      reply: "Thanks! Your key checks out. An admin needs to approve your account before you can use the bot — I'll let you know.",
      notifyAdminForChatId: user.telegram_chat_id,
    };
  }

  return {
    reply: wasAlreadyApproved ? "Key updated — you're all set." : "You're auto-approved as the admin. You're all set — try /help.",
  };
}
