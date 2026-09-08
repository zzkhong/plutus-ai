import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL = './data/test-voice-handler.db';

const testDbPath = path.resolve('./data/test-voice-handler.db');
if (fs.existsSync(testDbPath)) {
  fs.rmSync(testDbPath, { force: true });
}

before(async () => {
  const { runMigrations } = await import('../../db/migrate');
  runMigrations();
});

function geminiTextResponse(text: string): Response {
  const body = JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

function promptTextFromBody(requestBody: string | undefined): string {
  if (!requestBody) return '';
  try {
    const parsed = JSON.parse(requestBody);
    return (
      parsed?.contents?.[0]?.parts
        ?.map((p: { text?: string }) => p.text)
        .filter(Boolean)
        .join(' ') ?? ''
    );
  } catch {
    return '';
  }
}

function isTranscriptionRequest(requestBody: string | undefined): boolean {
  if (!requestBody) return false;
  try {
    const parsed = JSON.parse(requestBody);
    return Boolean(parsed?.contents?.[0]?.parts?.[0]?.inlineData);
  } catch {
    return false;
  }
}

/**
 * Stubs a full transcribe -> classify -> categorize round trip for a
 * transcript that reads as an expense message, so handleVoiceMessage's
 * downstream classifyUserMessage/logExpense calls resolve deterministically.
 */
function stubGeminiVoiceExpenseFlow(transcript: string): () => void {
  const originalFetch = global.fetch;

  global.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const body = init?.body as string | undefined;

    if (isTranscriptionRequest(body)) {
      return geminiTextResponse(transcript);
    }

    const promptText = promptTextFromBody(body);
    if (promptText.includes('User message:')) {
      return geminiTextResponse(
        JSON.stringify({
          intent: 'expense',
          confidence: 0.9,
          extracted: { amount: 4.5, merchant: 'Ya Kun' },
          rawText: transcript,
        }),
      );
    }

    return geminiTextResponse(JSON.stringify({ category: 'Food', confidence: 0.9 }));
  }) as typeof fetch;

  return () => {
    global.fetch = originalFetch;
  };
}

test('handleVoiceMessage returns a friendly message when transcription fails, without touching other services', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { handleVoiceMessage } = await import('./voice');
    const reply = await handleVoiceMessage(1, Buffer.from('fake ogg audio'), 'audio/ogg');

    assert.match(reply, /couldn't|trouble|sorry/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleVoiceMessage tells the user when the transcript is empty', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => geminiTextResponse('   ')) as typeof fetch;

  try {
    const { handleVoiceMessage } = await import('./voice');
    const reply = await handleVoiceMessage(2, Buffer.from('fake ogg audio'), 'audio/ogg');

    assert.match(reply, /couldn't make out/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('handleVoiceMessage transcribes, classifies, and logs a real expense tagged with source voice', async () => {
  const transcript = 'Spent $4.50 at Ya Kun';
  const restore = stubGeminiVoiceExpenseFlow(transcript);

  try {
    const { handleVoiceMessage } = await import('./voice');
    const reply = await handleVoiceMessage(3, Buffer.from('fake ogg audio'), 'audio/ogg');

    assert.match(reply, /Heard: "Spent \$4\.50 at Ya Kun"/);
    assert.match(reply, /Ya Kun/i);

    const { getTopExpenses } = await import('../../expense/service');
    const [logged] = await getTopExpenses('today', 1);
    assert.ok(logged);
    assert.equal(logged.merchant, 'Ya Kun');
    assert.equal(logged.source, 'voice');
  } finally {
    restore();
  }
});

test('handleVoiceMessage routes the transcript to an active split instead of classification', async () => {
  const chatId = 4;
  const { startSplit, clearSplit } = await import('../../split/state');
  startSplit(chatId);

  const originalFetch = global.fetch;
  global.fetch = (async () => geminiTextResponse('split it evenly among 3')) as typeof fetch;

  try {
    const { handleVoiceMessage } = await import('./voice');
    const reply = await handleVoiceMessage(chatId, Buffer.from('fake ogg audio'), 'audio/ogg');

    assert.match(reply, /waiting on a photo/i);
  } finally {
    global.fetch = originalFetch;
    clearSplit(chatId);
  }
});
