/**
 * Date helpers shared by user-facing messages and the expense engine. All of
 * them work in local time, which config pins to APP_TIMEZONE (process.env.TZ).
 */

/** e.g. "10 Sep 2026". */
export function formatDay(date: Date): string {
  return date.toLocaleDateString('en-SG', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** e.g. "August 2026". */
export function formatMonth(date: Date): string {
  return date.toLocaleDateString('en-SG', { month: 'long', year: 'numeric' });
}

/** e.g. "12 Sep" — for button labels, where space is short. */
export function formatShortDay(date: Date): string {
  return date.toLocaleDateString('en-SG', { day: 'numeric', month: 'short' });
}

/** "2026-09-12" — the form the classifier is given and returns. */
export function toIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * A "YYYY-MM-DD" date as local noon that day, or null if it isn't a real
 * date. Noon rather than midnight so the day can't shift in either direction
 * however it's bucketed.
 */
export function parseIsoDate(value: string | undefined | null): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value ?? '').trim());
  if (!match) {
    return null;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  // Rejects rollovers like 2026-02-31, which Date would turn into 3 March.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function isSameDay(a: Date, b: Date): boolean {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

export function isFutureDay(date: Date, now: Date = new Date()): boolean {
  return startOfDay(date).getTime() > startOfDay(now).getTime();
}

/**
 * A backdated day: `value` ("YYYY-MM-DD") when it's before today and, with
 * `maxAgeDays`, no further back than that. Anything else — today, a future
 * day, an unreadable value — gives undefined, meaning "now".
 */
export function earlierDay(value: string | undefined | null, now: Date = new Date(), maxAgeDays?: number): Date | undefined {
  const date = parseIsoDate(value);
  if (!date || startOfDay(date).getTime() >= startOfDay(now).getTime()) {
    return undefined;
  }
  const ageDays = (startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000;
  if (maxAgeDays !== undefined && ageDays > maxAgeDays) {
    return undefined;
  }
  return date;
}

/** The first moment of the month `offset` months from `date`'s month. */
export function startOfMonth(date: Date, offset = 0): Date {
  return new Date(date.getFullYear(), date.getMonth() + offset, 1);
}

export function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

/** "2026-09" — the month key budget alerts are deduplicated by. */
export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** 1 → "1st", 22 → "22nd", 13 → "13th". */
export function ordinal(n: number): string {
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) {
    return `${n}th`;
  }
  const suffixes: Record<number, string> = { 1: 'st', 2: 'nd', 3: 'rd' };
  return `${n}${suffixes[n % 10] ?? 'th'}`;
}
