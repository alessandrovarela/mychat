ALTER TABLE `audit_entries` ADD `execution_id` text;
--> statement-breakpoint
ALTER TABLE `audit_entries` ADD `automation_scope` text;
--> statement-breakpoint
ALTER TABLE `audit_entries` ADD `publication_id` text;
--> statement-breakpoint
CREATE INDEX `audit_execution_idx` ON `audit_entries` (`execution_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `audit_publication_idx` ON `audit_entries` (`publication_id`,`occurred_at`);
