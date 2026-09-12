import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBudgetStatus,
  formatCategorySpend,
  formatMoneyWithSgd,
  formatSpendingSummary,
} from './messages';

function status(overrides: Record<string, unknown> = {}) {
  return {
    category: 'Food',
    budget_amount: 50000,
    budget_currency: 'SGD',
    budget_sgd: 50000,
    spent_sgd: 20000,
    percentage: 40,
    remaining_sgd: 30000,
    days_left_in_month: 18,
    ...overrides,
  } as any;
}

test('formatSpendingSummary lists categories largest first, with counts', () => {
  const reply = formatSpendingSummary("This month's spend", {
    period: 'month',
    total: 12345,
    count: 3,
    byCategory: { Transport: 2345, Food: 10000 },
    byCategoryCount: { Transport: 1, Food: 2 },
    topExpenses: [],
  });

  assert.equal(
    reply,
    "This month's spend: S$123.45 across 3 transactions.\n  Food: S$100.00 (2)\n  Transport: S$23.45 (1)",
  );
});

test('formatSpendingSummary says so when nothing is logged', () => {
  const reply = formatSpendingSummary("Today's spend", {
    period: 'today',
    total: 0,
    count: 0,
    byCategory: {},
    byCategoryCount: {},
    topExpenses: [],
  });
  assert.equal(reply, "Today's spend: S$0.00. Nothing logged yet.");
});

test('formatMoneyWithSgd shows the original currency next to its SGD value', () => {
  assert.equal(formatMoneyWithSgd({ amount: 450, currency: 'SGD', amount_sgd: 450 }), 'S$4.50');
  assert.equal(formatMoneyWithSgd({ amount: 4500, currency: 'MYR', amount_sgd: 1402 }), 'RM45.00 (S$14.02)');
});

test('formatBudgetStatus shows what is left, or how far over, for each budget', () => {
  const reply = formatBudgetStatus([
    status(),
    status({ category: 'Transport', budget_sgd: 10000, spent_sgd: 12000, percentage: 120, remaining_sgd: -2000 }),
  ]);

  assert.equal(
    reply,
    'Budgets this month (18 days left):\n' +
      'Food: S$200.00 of S$500.00 (40%), S$300.00 left\n' +
      'Transport: S$120.00 of S$100.00 (120%), over by S$20.00',
  );
});

test('formatBudgetStatus explains how to start when there are no budgets', () => {
  assert.match(formatBudgetStatus([]), /No budgets set yet/);
});

test('formatCategorySpend answers for one category, adding its budget when there is one', () => {
  assert.equal(
    formatCategorySpend("This month's spend", 'Food', 20000, 5),
    "This month's spend on Food: S$200.00 across 5 transactions.",
  );
  assert.equal(
    formatCategorySpend("This month's spend", 'Food', 20000, 5, status()),
    "This month's spend on Food: S$200.00 across 5 transactions.\nThat's 40% of your S$500.00 budget, S$300.00 left.",
  );
});
