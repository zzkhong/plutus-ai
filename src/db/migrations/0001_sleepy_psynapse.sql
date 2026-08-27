CREATE TABLE `budget_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`budget_id` text NOT NULL,
	`threshold` integer NOT NULL,
	`month` text NOT NULL,
	`sent_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`budget_id`) REFERENCES `budgets`(`id`) ON UPDATE no action ON DELETE no action
);
