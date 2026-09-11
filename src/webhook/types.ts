/**
 * iOS Shortcut webhook payload/response types
 */

import { User } from '../users/types';

/** Hono env for the webhook app — `user` is set by apiKeyAuthMiddleware. */
export type WebhookEnv = {
  Variables: {
    user: User;
  };
};

export interface ApplePayPayload {
  amount: string;
  merchant: string;
  card: string;
}

export interface ApplePayResponse {
  status: 'logged';
  transaction: {
    amount: number;
    currency: string;
    merchant: string;
    category: string;
  };
}

export interface WebhookErrorResponse {
  status: 'error';
  message: string;
}
