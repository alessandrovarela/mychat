CREATE TABLE `automation_aggregates` (
	`id` text PRIMARY KEY NOT NULL,
	`definition` text NOT NULL,
	`publication_target` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_aggregates_publication_target_unique` ON `automation_aggregates` (`publication_target`);
