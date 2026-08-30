CREATE TABLE `platform_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`auth_path` text NOT NULL,
	`access_token` text NOT NULL,
	`account_id` text NOT NULL,
	`expires_at` integer,
	`last_checked_at` integer,
	`last_refreshed_at` integer,
	`updated_at` integer NOT NULL
);
