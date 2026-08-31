/**
 * iOS Shortcut webhook payload/response types
 */

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
