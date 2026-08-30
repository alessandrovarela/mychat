CREATE TABLE `contact_attributes` (
	`contact_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`contact_id`, `key`)
);
