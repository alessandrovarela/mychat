-- REQ-120, the half the deletion path cannot reach: rows written for an
-- automation that was already deleted, back when deleting one left its runs
-- behind. Each of them is inherited suppression waiting to happen, because an
-- automation recreated under that same id reads them as its own and
-- `once_per_contact` (REQ-015) then silences the delivery.
--
-- A run row is only ever consulted for the automation named in it, so one
-- whose automation does not exist can do nothing except suppress a future
-- automation. That is what makes deleting them safe rather than a judgement
-- call about somebody's data.
--
-- Nothing here touches `audit_entries`: the trail is a different record, it
-- carries its own `automation_id` with no foreign key, and it must go on
-- answering for runs of automations that no longer exist (REQ-056).
--
-- NOT EXISTS rather than NOT IN, so the result cannot turn on how the subquery
-- treats a null.
DELETE FROM `automation_runs`
WHERE NOT EXISTS (
  SELECT 1
  FROM `automations`
  WHERE `automations`.`id` = `automation_runs`.`automation_id`
);

