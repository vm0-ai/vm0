DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT "agent_id", "name"
      FROM "zero_workflows"
      WHERE "type" = 'workflow'
      GROUP BY "agent_id", "name"
      HAVING COUNT(*) > 1
    ) duplicates
  ) THEN
    RAISE EXCEPTION 'Cannot add idx_zero_workflows_agent_name_unique: duplicate workflow names exist for at least one agent';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_zero_workflows_agent_name_unique" ON "zero_workflows" USING btree ("agent_id","name") WHERE type = 'workflow';
