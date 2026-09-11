/**
 * GET /api/cron/* — the daily triggers Vercel Cron calls on the schedules in
 * vercel.json (the recurring-charge job and the nightly digest).
 *
 * Vercel sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set
 * on the project. Without the check, anyone could hit the URL and make the
 * bot message every user, so an unset secret refuses to run the job at all.
 */

import { Context } from 'hono';
import { logger } from '../../utils/logger';
import { safeEqual } from '../../utils/secure-compare';

export function createCronHandler(name: string, job: () => Promise<void>, options: { secret: string | undefined }) {
  return async (c: Context): Promise<Response> => {
    if (!options.secret) {
      logger.error(`Refusing to run cron "${name}": CRON_SECRET is not configured`);
      return c.json({ status: 'error', message: 'CRON_SECRET is not configured' }, 503);
    }

    if (!safeEqual(c.req.header('authorization'), `Bearer ${options.secret}`)) {
      return c.json({ status: 'error', message: 'Unauthorized' }, 401);
    }

    const startedAt = Date.now();
    try {
      await job();
    } catch (error) {
      logger.error(`Cron "${name}" failed`, error);
      return c.json({ status: 'error', message: `Cron ${name} failed` }, 500);
    }

    logger.info(`Cron "${name}" finished in ${Date.now() - startedAt}ms`);
    return c.json({ status: 'ok', job: name });
  };
}
