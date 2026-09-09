import test from 'node:test';
import assert from 'node:assert/strict';

function geminiRestResponse(text: string): Response {
  const body = JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

test('generateText returns the text from a successful call', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => geminiRestResponse('Hello from Gemini')) as typeof fetch;

  try {
    const { GeminiProvider } = await import('./gemini');
    const provider = new GeminiProvider('fake-api-key');
    const result = await provider.generateText({
      systemInstruction: 'You are a test.',
      contents: [{ text: 'Say hello' }],
    });
    assert.equal(result, 'Hello from Gemini');
  } finally {
    global.fetch = originalFetch;
  }
});

test('generateText sends multimodal inlineData parts through to the request body', async () => {
  const originalFetch = global.fetch;
  let capturedBody: string | undefined;
  global.fetch = (async (_input, init) => {
    capturedBody = init?.body as string;
    return geminiRestResponse('transcribed text');
  }) as typeof fetch;

  try {
    const { GeminiProvider } = await import('./gemini');
    const provider = new GeminiProvider('fake-api-key');
    await provider.generateText({
      systemInstruction: 'Transcribe this.',
      contents: [
        { inlineData: { mimeType: 'audio/ogg', data: Buffer.from('fake audio').toString('base64') } },
        { text: 'Transcribe.' },
      ],
    });

    assert.ok(capturedBody);
    const parsed = JSON.parse(capturedBody!);
    assert.ok(parsed.contents[0].parts[0].inlineData);
    assert.equal(parsed.contents[0].parts[0].inlineData.mimeType, 'audio/ogg');
  } finally {
    global.fetch = originalFetch;
  }
});

test('generateText propagates a network failure', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => {
    throw new Error('simulated network failure');
  }) as typeof fetch;

  try {
    const { GeminiProvider } = await import('./gemini');
    const provider = new GeminiProvider('fake-api-key');
    await assert.rejects(() =>
      provider.generateText({ systemInstruction: 'x', contents: [{ text: 'y' }] }),
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('generateText rejects once the call exceeds its timeoutMs', async () => {
  const originalFetch = global.fetch;
  global.fetch = (() => new Promise(() => {})) as unknown as typeof fetch; // never resolves

  try {
    const { GeminiProvider } = await import('./gemini');
    const provider = new GeminiProvider('fake-api-key');
    await assert.rejects(
      () => provider.generateText({ systemInstruction: 'x', contents: [{ text: 'y' }], timeoutMs: 50 }),
      /timed out/,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('getProviderForUser returns a GeminiProvider for a user configured with gemini', async () => {
  const { getProviderForUser } = await import('./provider');
  const { GeminiProvider } = await import('./gemini');
  const { encrypt } = await import('../users/crypto');

  const provider = getProviderForUser({
    id: 'u1',
    telegram_chat_id: 'chat-1',
    status: 'approved',
    is_admin: false,
    llm_provider: 'gemini',
    llm_api_key_encrypted: encrypt('fake-key'),
    webhook_api_key: 'wh-1',
    created_at: new Date(),
    updated_at: new Date(),
  });

  assert.ok(provider instanceof GeminiProvider);
});

test('getProviderForUser throws when the user has no provider configured yet', async () => {
  const { getProviderForUser } = await import('./provider');

  assert.throws(() =>
    getProviderForUser({
      id: 'u2',
      telegram_chat_id: 'chat-2',
      status: 'onboarding',
      is_admin: false,
      llm_provider: null,
      llm_api_key_encrypted: null,
      webhook_api_key: null,
      created_at: new Date(),
      updated_at: new Date(),
    }),
  );
});
