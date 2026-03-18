DROP INDEX "uq_credit_pricing_model";--> statement-breakpoint
ALTER TABLE "credit_pricing" ADD COLUMN "model_provider" varchar(100);--> statement-breakpoint
ALTER TABLE "credit_usage" ADD COLUMN "model_provider" varchar(100);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_credit_pricing_model_provider" ON "credit_pricing" USING btree ("model","model_provider");