CREATE TABLE `storage_configuration` (
  `id` text PRIMARY KEY NOT NULL,
  `driver` text NOT NULL,
  `endpoint` text,
  `access_key_id` text,
  `secret_access_key` text,
  `bucket` text,
  `updated_at` integer NOT NULL
);
