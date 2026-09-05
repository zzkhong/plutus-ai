/**
 * Test-only stub for the Gemini REST API, so tests that exercise
 * logExpense/inferCategory (src/expense/categorizer.ts) don't make real
 * network calls or burn Gemini API quota. Keyword-matches the merchant/note
 * text embedded in the categorization prompt to return a deterministic
 * category, mirroring the shape the @google/generative-ai SDK expects back
 * from fetch (see generateContent() in its dist, which does
 * `response.json()` then reads candidates[0].content.parts[0].text).
 */

const CATEGORY_KEYWORDS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /kopi|toast|hawker|restaurant|cafe|food/i, category: 'Food' },
  { pattern: /grab|taxi|mrt|lrt|transport/i, category: 'Transport' },
  { pattern: /netflix|spotify|movie|entertainment/i, category: 'Entertainment' },
  { pattern: /fairprice|giant|grocery|groceries|supermarket/i, category: 'Groceries' },
];

function categoryForPromptText(promptText: string): string {
  const match = CATEGORY_KEYWORDS.find(({ pattern }) => pattern.test(promptText));
  return match?.category ?? 'Others';
}

function extractPromptText(requestBody: string | undefined): string {
  if (!requestBody) {
    return '';
  }
  try {
    const parsed = JSON.parse(requestBody);
    return parsed?.contents?.[0]?.parts?.[0]?.text ?? '';
  } catch {
    return '';
  }
}

function geminiRestResponse(text: string): Response {
  const body = JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

/**
 * Stubs global.fetch so any Gemini categorization call (from inferCategory)
 * resolves instantly with a category derived from the merchant/note text in
 * the prompt, instead of hitting the real API. Returns a restore function —
 * always call it in a `finally` block.
 */
export function stubGeminiCategorization(): () => void {
  const originalFetch = global.fetch;

  global.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const promptText = extractPromptText(init?.body as string | undefined);
    const category = categoryForPromptText(promptText);
    return geminiRestResponse(JSON.stringify({ category, confidence: 0.9 }));
  }) as typeof fetch;

  return () => {
    global.fetch = originalFetch;
  };
}
