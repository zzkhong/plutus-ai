/**
 * Grammy context extended with the resolved users row, attached by
 * authMiddleware once a chat_id maps to a known user.
 */

import { Context } from 'grammy';
import { User } from '../users/types';

export interface BotContext extends Context {
  user?: User;
}
