ALTER TABLE `durable_work` ADD `send_class` text;--> statement-breakpoint
CREATE INDEX `durable_work_quota_idx` ON `durable_work` (`send_class`,`status`,`updated_at`);