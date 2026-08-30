CREATE TABLE `automation_pending_publication_baselines` (
	`automation_id` text NOT NULL,
	`publication_id` text NOT NULL,
	PRIMARY KEY(`automation_id`, `publication_id`)
);
--> statement-breakpoint
CREATE INDEX `automation_pending_publication_baselines_publication_idx` ON `automation_pending_publication_baselines` (`publication_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `automation_pending_publication_baselines` (`automation_id`, `publication_id`)
SELECT `automation_aggregates`.`id`, json_each.value
FROM `automation_aggregates`, json_each(`automation_aggregates`.`pending_publication_baseline`)
WHERE `automation_aggregates`.`pending_publication_baseline` IS NOT NULL
  AND json_valid(`automation_aggregates`.`pending_publication_baseline`);
