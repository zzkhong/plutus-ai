/**
 * Expense engine public API.
 */

export * from './types';
export * from './categorizer';
export * from './currency-resolver';
export {
  compareSpending,
  correctLastTransaction,
  correctTransaction,
  createRecurring,
  deleteTransaction,
  exportCSV,
  findRecurringForMerchant,
  fireRecurringForToday,
  getRecurringFiredToday,
  getSpendingByCategory,
  getSpendingSummary,
  getTopExpenses,
  getTransaction,
  listRecentTransactions,
  listRecurring,
  listTransactionsBetween,
  logExpense,
  logRecurringIfDue,
  matchRecurring,
  pauseRecurring,
  rememberedCategory,
  removeRecurring,
  setTransactionCategory,
  summarizeTransactions,
  undoLastTransaction,
} from './service';
export type { CsvExport } from './service';
