ALTER TABLE "automations" ADD COLUMN "run_group_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "run_group_id" uuid;--> statement-breakpoint
ALTER TABLE "zero_runs" ADD COLUMN "run_group_id" uuid;--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" ADD COLUMN "run_group_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_automations_run_group" ON "automations" USING btree ("run_group_id");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_run_group_id" ON "chat_messages" USING btree ("run_group_id") WHERE "chat_messages"."run_group_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_zero_runs_run_group" ON "zero_runs" USING btree ("run_group_id") WHERE run_group_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_zero_workflow_triggers_run_group" ON "zero_workflow_triggers" USING btree ("run_group_id");