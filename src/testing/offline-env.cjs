/**
 * Loaded before every test file (the `test` script passes it to --import).
 *
 * Keeps the suite off the network for exchange rates: an empty
 * EXCHANGE_RATE_API_KEY counts as unset in config, and dotenv never
 * overrides a variable that is already defined, so a real key in .env can't
 * make a test call exchangerate-api. Rates then come from the built-in
 * fallback, which keeps every conversion in the suite deterministic.
 */
process.env.EXCHANGE_RATE_API_KEY = '';
