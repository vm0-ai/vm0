ALTER TABLE "zero_runs" ADD COLUMN "automation_id" uuid;--> statement-breakpoint
ALTER TABLE "zero_runs" ADD COLUMN "trigger_id" uuid;--> statement-breakpoint
ALTER TABLE "zero_runs" ADD CONSTRAINT "zero_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zero_runs" ADD CONSTRAINT "zero_runs_trigger_id_automation_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."automation_triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_zero_runs_automation" ON "zero_runs" USING btree ("automation_id") WHERE automation_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_zero_runs_trigger" ON "zero_runs" USING btree ("trigger_id") WHERE trigger_id IS NOT NULL;