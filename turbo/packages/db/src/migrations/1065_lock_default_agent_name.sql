-- Custom SQL migration file, put your code below! --
UPDATE "agents" AS "agent"
SET "display_name" = 'Okou'
FROM "org_metadata" AS "metadata"
WHERE
  "metadata"."default_agent_id" = "agent"."id"
  AND "metadata"."org_id" = "agent"."org_id"
  AND "agent"."display_name" IS DISTINCT FROM 'Okou';
