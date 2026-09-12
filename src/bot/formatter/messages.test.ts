import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBudgetStatus,
  formatCategorySpend,
  formatExpenseLine,
  formatMoneyWithSgd,
  formatSavings,
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

test('formatBudgetStatus adds where the month is heading, while under a budget it will overshoot', () => {
  const reply = formatBudgetStatus([
    status({ projected_sgd: 62000 }),
    status({ category: 'Transport', projected_sgd: 9000 }),
    status({ category: 'Bills', budget_sgd: 10000, spent_sgd: 12000, percentage: 120, remaining_sgd: -2000, projected_sgd: 30000 }),
  ]);

  const [, food, transport, bills] = reply.split('\n');
  assert.equal(food, 'Food: S$200.00 of S$500.00 (40%), S$300.00 left, on pace for S$620.00');
  assert.doesNotMatch(transport, /on pace/, 'on track');
  assert.equal(bills, 'Bills: S$120.00 of S$100.00 (120%), over by S$20.00', 'already over');
});

test('formatSavings shows the savings rate, or how far spending went past income', () => {
  assert.equal(formatSavings(0, 1000), null);
  assert.equal(formatSavings(500000, 123400), 'Income: S$5000.00 · saved S$3766.00 (75.3%).');
  assert.equal(formatSavings(100000, 150000), 'Income: S$1000.00 · spent S$500.00 more than that.');
});

test('formatExpenseLine names the day only when it was not today', () => {
  const now = new Date(2026, 5, 20, 15);
  const expense = {
    id: 'x',
    amount: 450,
    currency: 'SGD' as const,
    amount_sgd: 450,
    merchant: 'Ya Kun',
    category: 'Food' as const,
    source: 'text',
    card_name: 'General',
    spent_at: new Date(2026, 5, 20, 8),
    created_at: now,
  };

  assert.equal(formatExpenseLine(expense, now), 'S$4.50 at Ya Kun under Food');
  assert.equal(
    formatExpenseLine({ ...expense, spent_at: new Date(2026, 5, 18, 12) }, now),
    'S$4.50 at Ya Kun under Food, on 18 Jun 2026',
  );
});
