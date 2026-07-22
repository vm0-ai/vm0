ALTER TABLE "agent_runs" ADD COLUMN "storage_mounts" jsonb;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN "storage_mounts" jsonb;--> statement-breakpoint
ALTER TABLE "checkpoints" ADD COLUMN "storage_mounts" jsonb;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM storages
    GROUP BY org_id, user_id, name
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'storages has duplicate canonical identities — resolve before adding idx_storages_org_user_name';
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_storages_org_user_name" ON "storages" USING btree ("org_id","user_id","name");
