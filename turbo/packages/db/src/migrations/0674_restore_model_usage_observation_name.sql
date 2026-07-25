ALTER TABLE "compact_model_usage_observation" RENAME TO "model_usage_observation";--> statement-breakpoint
ALTER INDEX "compact_model_usage_observation_pkey" RENAME TO "model_usage_observation_pkey";--> statement-breakpoint
DROP INDEX "idx_compact_model_usage_observation_observed_at";--> statement-breakpoint
CREATE INDEX "idx_model_usage_observation_observed_at" ON "model_usage_observation" USING btree ("observed_at" DESC NULLS LAST);
