CREATE TABLE `button_clicks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`occurred_at` integer NOT NULL,
	`automation_id` text NOT NULL,
	`button_id` text NOT NULL,
	`destination_id` integer NOT NULL,
	`destination_version` integer NOT NULL,
	`contact_id` text NOT NULL,
	`execution_id` text NOT NULL,
	FOREIGN KEY (`destination_id`) REFERENCES `button_destinations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `button_clicks_automation_idx` ON `button_clicks` (`automation_id`);--> statement-breakpoint
CREATE INDEX `button_clicks_button_idx` ON `button_clicks` (`automation_id`,`button_id`);--> statement-breakpoint
CREATE TABLE `button_destinations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`automation_id` text NOT NULL,
	`button_id` text NOT NULL,
	`version` integer NOT NULL,
	`url` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `button_destinations_version_unique` ON `button_destinations` (`automation_id`,`button_id`,`version`);--> statement-breakpoint
CREATE INDEX `button_destinations_latest_idx` ON `button_destinations` (`automation_id`,`button_id`,`version`);
