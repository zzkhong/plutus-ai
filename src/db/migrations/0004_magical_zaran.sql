CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`telegram_chat_id` text NOT NULL,
	`status` text NOT NULL,
	`is_admin` integer DEFAULT 0 NOT NULL,
	`llm_provider` text,
	`llm_api_key_encrypted` text,
	`webhook_api_key` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_telegram_chat_id_unique` ON `users` (`telegram_chat_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_webhook_api_key_unique` ON `users` (`webhook_api_key`);--> statement-breakpoint
ALTER TABLE `budget_alerts` ADD `user_id` text NOT NULL REFERENCES users(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `budgets` ADD `user_id` text NOT NULL REFERENCES users(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `holdings` ADD `user_id` text NOT NULL REFERENCES users(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `recurring_transactions` ADD `user_id` text NOT NULL REFERENCES users(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `transactions` ADD `user_id` text NOT NULL REFERENCES users(id) ON DELETE CASCADE;