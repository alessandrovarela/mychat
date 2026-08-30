CREATE TABLE `durable_work` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`status` text NOT NULL,
	`due_at` integer NOT NULL,
	`attempts` integer NOT NULL,
	`payload` text NOT NULL,
	`contact_id` text,
	`execution_id` text,
	`last_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `durable_work_dedupe_key_unique` ON `durable_work` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `durable_work_due_idx` ON `durable_work` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `durable_work_execution_idx` ON `durable_work` (`execution_id`);