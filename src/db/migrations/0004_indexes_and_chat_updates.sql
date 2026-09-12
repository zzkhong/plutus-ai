CREATE TABLE `chat_updates` (
	`update_id` integer PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `chat_updates_chat_idx` ON `chat_updates` (`chat_id`,`update_id`);--> statement-breakpoint
CREATE INDEX `budget_alerts_budget_idx` ON `budget_alerts` (`budget_id`,`threshold`,`month`);--> statement-breakpoint
CREATE INDEX `budgets_user_category_idx` ON `budgets` (`user_id`,`category`);--> statement-breakpoint
CREATE INDEX `holdings_user_idx` ON `holdings` (`user_id`);--> statement-breakpoint
CREATE INDEX `income_user_received_idx` ON `income` (`user_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `recurring_transactions_user_idx` ON `recurring_transactions` (`user_id`);--> statement-breakpoint
CREATE INDEX `transactions_user_created_idx` ON `transactions` (`user_id`,`created_at`);