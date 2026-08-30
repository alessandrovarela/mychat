CREATE TABLE `automation_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`automation_id` text NOT NULL,
	`definition` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `automation_revisions_automation_idx` ON `automation_revisions` (`automation_id`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `flow_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`flow_id` text NOT NULL,
	`definition` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `flow_revisions_flow_idx` ON `flow_revisions` (`flow_id`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `instance_preferences` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operator_credential` (
	`id` text PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`algorithm` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `publication_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`media_type` text NOT NULL,
	`published_at` integer NOT NULL,
	`thumbnail_key` text,
	`cached_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `publication_cache_published_idx` ON `publication_cache` (`published_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
ALTER TABLE `audit_entries` ADD `subtype` text;--> statement-breakpoint
CREATE INDEX `audit_subtype_idx` ON `audit_entries` (`kind`,`subtype`,`occurred_at`);