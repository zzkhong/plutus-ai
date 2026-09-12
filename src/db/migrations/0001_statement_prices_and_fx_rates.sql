CREATE TABLE `fx_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`rates` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `holdings` ADD `price` real;--> statement-breakpoint
ALTER TABLE `holdings` ADD `price_as_of` integer;