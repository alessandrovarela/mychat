ALTER TABLE `audit_entries` ADD `platform_message_id` text;
--> statement-breakpoint
CREATE INDEX `audit_platform_message_idx` ON `audit_entries` (`platform_message_id`);
