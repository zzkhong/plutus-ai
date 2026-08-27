PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_budget_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`budget_id` text NOT NULL,
	`threshold` integer NOT NULL,
	`month` text NOT NULL,
	`sent_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`budget_id`) REFERENCES `budgets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_budget_alerts`("id", "budget_id", "threshold", "month", "sent_at") SELECT "id", "budget_id", "threshold", "month", "sent_at" FROM `budget_alerts`;--> statement-breakpoint
DROP TABLE `budget_alerts`;--> statement-breakpoint
ALTER TABLE `__new_budget_alerts` RENAME TO `budget_alerts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;