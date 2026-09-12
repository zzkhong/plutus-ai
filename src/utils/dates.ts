/**
 * Date formatting shared by user-facing messages.
 */

/** e.g. "10 Sep 2026", in the app's timezone (config pins process.env.TZ). */
export function formatDay(date: Date): string {
  return date.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
}
