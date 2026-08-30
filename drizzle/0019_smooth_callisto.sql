ALTER TABLE `automation_aggregates` ADD `scope_type` text;--> statement-breakpoint
ALTER TABLE `automation_aggregates` ADD `global_match` text;--> statement-breakpoint
CREATE UNIQUE INDEX `automation_aggregates_next_publication_unique` ON `automation_aggregates` (`scope_type`) WHERE "automation_aggregates"."scope_type" = 'next_publication';--> statement-breakpoint
CREATE UNIQUE INDEX `automation_aggregates_global_match_unique` ON `automation_aggregates` (`global_match`) WHERE "automation_aggregates"."global_match" is not null;