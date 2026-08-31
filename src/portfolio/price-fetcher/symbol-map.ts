/**
 * Manual mapping from a broker statement's reported symbol to the Yahoo
 * Finance chart-API symbol, for MY (Bursa, `.KL`) and SG (SGX, `.SI`)
 * stocks. A Moomoo statement reports a stock by name or local code, which
 * won't reliably match Yahoo's numeric/ticker symbol — fill in an entry
 * here whenever a new MY/SG holding is added. An unmapped symbol degrades
 * to "price unavailable" rather than guessing.
 */
export const SYMBOL_MAP: Record<string, string> = {
  // e.g. 'MAYBANK': '1155.KL', 'SIA': 'C6L.SI'
};

export function resolveYahooSymbol(statementSymbol: string): string | null {
  return SYMBOL_MAP[statementSymbol] ?? null;
}
