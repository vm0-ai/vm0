WITH ranked_public_workflows AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY org_id, agent_id, name
      ORDER BY created_at ASC, id ASC
    ) AS row_number
  FROM zero_workflows
  WHERE visibility = 'public' AND type = 'workflow'
)
UPDATE zero_workflows
SET
  visibility = 'private',
  request_to_publish = false,
  updated_at = now()
FROM ranked_public_workflows
WHERE zero_workflows.id = ranked_public_workflows.id
  AND ranked_public_workflows.row_number > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_zero_workflows_public_agent_name_unique" ON "zero_workflows" USING btree ("org_id","agent_id","name") WHERE visibility = 'public' AND type = 'workflow';
