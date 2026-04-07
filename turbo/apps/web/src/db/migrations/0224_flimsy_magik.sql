CREATE TABLE "insights_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"date" date NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_insights_daily_org_date" ON "insights_daily" USING btree ("org_id","date");--> statement-breakpoint
CREATE INDEX "idx_insights_daily_org_date_desc" ON "insights_daily" USING btree ("org_id","date" DESC NULLS LAST);