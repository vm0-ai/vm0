ALTER TABLE "agent_run_queue" ADD COLUMN "org_id" text;--> statement-breakpoint
UPDATE "agent_run_queue" SET "org_id" = "agent_runs"."org_id" FROM "agent_runs" WHERE "agent_run_queue"."run_id" = "agent_runs"."id";--> statement-breakpoint
ALTER TABLE "agent_run_queue" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_run_queue_org_created_idx" ON "agent_run_queue" USING btree ("org_id","created_at");