ALTER TABLE "credit_usage" ADD COLUMN "result_uuid" uuid;--> statement-breakpoint
ALTER TABLE "credit_usage" DROP COLUMN "num_events";--> statement-breakpoint
DROP INDEX "uq_credit_usage_run_id";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_credit_usage_run_result" ON "credit_usage" USING btree ("run_id","result_uuid");--> statement-breakpoint
CREATE INDEX "idx_credit_usage_run_id" ON "credit_usage" USING btree ("run_id");
