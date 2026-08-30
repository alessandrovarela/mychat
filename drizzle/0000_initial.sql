CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`schema_version` integer NOT NULL,
	`name` text NOT NULL,
	`enabled` integer NOT NULL,
	`trigger_type` text NOT NULL,
	`trigger_target` text,
	`trigger_keywords` text NOT NULL,
	`trigger_match_mode` text NOT NULL,
	`flow_id` text NOT NULL,
	`param_values` text,
	`once_per_contact` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `automations_trigger_idx` ON `automations` (`trigger_type`,`trigger_target`);--> statement-breakpoint
CREATE INDEX `automations_flow_idx` ON `automations` (`flow_id`);--> statement-breakpoint
CREATE TABLE `flows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`definition` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
