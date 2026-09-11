/**
 * Manual overrides from a statement's reported symbol to a Yahoo Finance
 * chart-API symbol, for MY (Bursa, `.KL`) and SG (SGX, `.SI`) stocks.
 *
 * Usually not needed: a bare exchange code is resolved automatically
 * (`D05` → `D05.SI`, `1155` → `1155.KL`, see stocks.ts). Add an entry only
 * when a statement reports a stock some other way — by name, say — that
 * can't be turned into its code.
 */
export const SYMBOL_MAP: Record<string, string> = {
  // e.g. 'MAYBANK': '1155.KL', 'SIA': 'C6L.SI'
};

export function resolveYahooSymbol(statementSymbol: string): string | null {
  return SYMBOL_MAP[statementSymbol] ?? null;
}
