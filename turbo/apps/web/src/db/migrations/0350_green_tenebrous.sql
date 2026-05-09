DROP INDEX "idx_org_model_policies_org_sort_order";--> statement-breakpoint
DROP INDEX "idx_org_model_policies_enabled_sort";--> statement-breakpoint
ALTER TABLE "org_model_policies" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
WITH ranked_defaults AS (
	SELECT
		"id",
		ROW_NUMBER() OVER (
			PARTITION BY "org_id"
			ORDER BY
				CASE WHEN "enabled" THEN 0 ELSE 1 END,
				"sort_order" ASC,
				"created_at" ASC
		) AS "rank"
	FROM "org_model_policies"
)
UPDATE "org_model_policies"
SET "is_default" = true
FROM ranked_defaults
WHERE "org_model_policies"."id" = ranked_defaults."id"
	AND ranked_defaults."rank" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_org_model_policies_one_default_per_org" ON "org_model_policies" USING btree ("org_id") WHERE is_default = true;--> statement-breakpoint
CREATE INDEX "idx_org_model_policies_enabled" ON "org_model_policies" USING btree ("org_id","enabled");--> statement-breakpoint
ALTER TABLE "org_model_policies" DROP COLUMN "sort_order";
