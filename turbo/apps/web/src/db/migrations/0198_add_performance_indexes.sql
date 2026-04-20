CREATE INDEX "idx_agent_runs_org_status_created" ON "agent_runs" USING btree ("org_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_credit_usage_org_user_status_processed" ON "credit_usage" USING btree ("org_id","user_id","status","processed_at");--> statement-breakpoint
CREATE INDEX "idx_zero_agent_schedules_user_org" ON "zero_agent_schedules" USING btree ("user_id","org_id");
