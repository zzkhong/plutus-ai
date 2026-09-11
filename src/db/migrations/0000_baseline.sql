CREATE TABLE `budget_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`budget_id` text NOT NULL,
	`threshold` integer NOT NULL,
	`month` text NOT NULL,
	`sent_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`budget_id`) REFERENCES `budgets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`category` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`amount_sgd` integer NOT NULL,
	`period` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `holdings` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`asset_class` text NOT NULL,
	`quantity` real NOT NULL,
	`currency` text NOT NULL,
	`market` text NOT NULL,
	`broker` text,
	`cost_basis` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recurring_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`merchant` text NOT NULL,
	`category` text NOT NULL,
	`day_of_month` integer NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `split_sessions` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`amount_sgd` integer NOT NULL,
	`merchant` text NOT NULL,
	`category` text NOT NULL,
	`source` text NOT NULL,
	`card_name` text NOT NULL,
	`note` text,
	`recurring_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE UNIQUE INDEX `users_webhook_api_key_unique` ON `users` (`webhook_api_key`);