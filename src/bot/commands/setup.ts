/**
 * /setup flow: pick a provider (gemini only for now) -> paste an API key
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
import { logger } from '../../utils/logger';

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

  return 'Welcome to Plutus AI! Which LLM provider would you like to use? Reply with: gemini';
}

/** Why a key check failed, as far as the error says. */
export type KeyFailure = 'invalid' | 'rate_limited' | 'unavailable';

/**
 * Reads a failed key check's error. Only a rejection that names the key, or
 * an auth status, is the key's fault. A rate limit means the key itself
 * worked. Anything else — a model that isn't available, a timeout, an
 * outage — says nothing about the key, so the user isn't sent off to replace
 * a good one.
 */
export function classifyKeyFailure(message: string): KeyFailure {
  if (/\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(message)) {
    return 'rate_limited';
  }
  if (/API key not valid|API_KEY_INVALID|\b40[13]\b|PERMISSION_DENIED|UNAUTHENTICATED/i.test(message)) {
    return 'invalid';
  }
  return 'unavailable';
}

const KEY_FAILURE_REPLIES: Record<KeyFailure, string> = {
  invalid: "That key didn't work — Google rejected it. Check it at https://aistudio.google.com/apikey and resend it.",
  rate_limited: "Google says this key is over its rate limit right now, so I can't check it. Wait a minute, then resend it.",
  unavailable:
    "I couldn't check that key just now — Gemini didn't answer properly. Please resend it in a minute. If it keeps happening, the bot's admin can see why in the logs.",
};

/** Null when the key works; otherwise why it didn't. */
async function checkApiKey(apiKey: string): Promise<KeyFailure | null> {
  try {
    await new GeminiProvider(apiKey).generateText({
      systemInstruction: 'You are a health check.',
      contents: [{ text: 'Reply with OK.' }],
      timeoutMs: 10000,
    });
    return null;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    // Never log the key itself, even if an error were to echo it back.
    const message = apiKey ? raw.split(apiKey).join('[key]') : raw;
    const failure = classifyKeyFailure(message);
    logger.warn('Gemini API key check failed', { failure, message });
    return failure;
  }
}

const KEY_REQUEST = [
  "Got it — now send me your Gemini API key (get one at https://aistudio.google.com/apikey). I'll delete your message right after.",
  "Good to know: I read your messages, receipts and statements with Google Gemini, using this key. On Gemini's free tier, Google may use what's sent to improve its products; keys from a Google Cloud project with billing enabled aren't used that way.",
].join('\n\n');

export async function handleSetupTextMessage(user: User, text: string): Promise<SetupTextResult> {
  const trimmed = text.trim();

  if (!user.llm_provider) {
    const providerName = trimmed.toLowerCase();
    if (!SUPPORTED_PROVIDERS.has(providerName)) {
      return { reply: `That provider is not available yet — reply "gemini" for now.` };
    }
    await setProvider(user.id, 'gemini');
    return { reply: KEY_REQUEST };
  }

  const failure = await checkApiKey(trimmed);
  if (failure) {
    return { reply: KEY_FAILURE_REPLIES[failure] };
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
