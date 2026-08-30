CREATE TABLE `audit_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`occurred_at` integer NOT NULL,
	`kind` text NOT NULL,
	`outcome` text NOT NULL,
	`contact_id` text,
	`flow_id` text,
	`step_id` text,
	`automation_id` text,
	`event_id` text,
	`reason` text
);
--> statement-breakpoint
CREATE INDEX `audit_occurred_idx` ON `audit_entries` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `audit_contact_idx` ON `audit_entries` (`contact_id`);--> statement-breakpoint
CREATE INDEX `audit_event_idx` ON `audit_entries` (`event_id`);