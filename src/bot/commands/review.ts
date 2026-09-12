/**
 * /review — last month in review, the same message the 1st-of-the-month job sends.
 */

import { buildMonthReview } from '../../review';
import { formatMonth, startOfMonth } from '../../utils/dates';

export async function handleReviewCommand(userId: string, now: Date = new Date()): Promise<string> {
  const review = await buildMonthReview(userId, now);
  if (review) {
    return review;
  }
  return `Nothing was logged in ${formatMonth(startOfMonth(now, -1))}, so there's nothing to review. A review of each month arrives on the 1st.`;
}
