CREATE TABLE `income` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text NOT NULL,
	`amount_sgd` integer NOT NULL,
	`source` text NOT NULL,
	`note` text,
	`received_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `transactions` ADD `spent_at` integer;--> statement-breakpoint
-- Hand-added: existing expenses were spent when they were logged.
UPDATE `transactions` SET `spent_at` = `created_at` WHERE `spent_at` IS NULL;