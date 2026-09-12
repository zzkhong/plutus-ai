/**
 * Registers, inspects, or removes the bot's Telegram webhook.
 *
 *   npm run telegram:webhook -- set https://your-app.vercel.app
 *   npm run telegram:webhook -- info
 *   npm run telegram:webhook -- delete
 *
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from the environment
 * (or .env). `set` registers <base-url>/api/telegram along with the secret,
 * which Telegram then sends on every delivery as
 * X-Telegram-Bot-Api-Secret-Token — the route rejects anything without it.
 *
 * Deliberately doesn't load src/config: registering a webhook shouldn't
 * require ENCRYPTION_KEY or a database.
 */

import dotenv from 'dotenv';
import { Api } from 'grammy';

dotenv.config();

const USAGE = 'Usage: npm run telegram:webhook -- <set <https-base-url> | info | delete>';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, baseUrl] = process.argv.slice(2);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    fail('TELEGRAM_BOT_TOKEN is not set.');
  }
  const api = new Api(token);

  switch (command) {
    case 'set': {
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
      if (!secret) {
        fail('TELEGRAM_WEBHOOK_SECRET is not set — use the same value you configured on Vercel.');
      }
      if (!baseUrl) {
        fail(USAGE);
      }
      const url = new URL('/api/telegram', baseUrl).toString();
      if (!url.startsWith('https://')) {
        fail(`Telegram only delivers webhooks over HTTPS, got ${url}`);
      }
      // Commands, text, voice notes, photos and files arrive as messages;
      // presses on the Change category / Undo buttons as callback queries.
      // Telegram never delivers a type left out here, so a webhook set
      // before the buttons existed has to be set again.
      await api.setWebhook(url, { secret_token: secret, allowed_updates: ['message', 'callback_query'] });
      console.log(`Webhook set: ${url}`);
      console.log('Send /help to the bot to check it responds.');
      break;
    }
    case 'info': {
      const info = await api.getWebhookInfo();
      console.log(JSON.stringify(info, null, 2));
      break;
    }
    case 'delete': {
      await api.deleteWebhook();
      console.log('Webhook deleted — the bot can now be long-polled by `npm run dev`.');
      break;
    }
    default:
      fail(USAGE);
  }
}

main().catch((error) => {
  fail(`Telegram API call failed: ${error instanceof Error ? error.message : String(error)}`);
});
