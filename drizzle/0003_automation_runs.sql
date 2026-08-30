CREATE TABLE `automation_runs` (
	`automation_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`first_run_at` integer NOT NULL,
	PRIMARY KEY(`automation_id`, `contact_id`)
);
--> statement-breakpoint
CREATE INDEX `automation_runs_contact_idx` ON `automation_runs` (`contact_id`);