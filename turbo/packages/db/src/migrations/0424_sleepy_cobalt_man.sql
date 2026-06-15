CREATE TABLE "memory_change_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"summary_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"title" text,
	"description" text,
	"file_path" text NOT NULL,
	"before_snippet" text,
	"after_snippet" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_change_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"date" date NOT NULL,
	"from_version_id" varchar(64),
	"to_version_id" varchar(64) NOT NULL,
	"summary" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_change_items" ADD CONSTRAINT "memory_change_items_summary_id_memory_change_summaries_id_fk" FOREIGN KEY ("summary_id") REFERENCES "public"."memory_change_summaries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_memory_change_items_summary" ON "memory_change_items" USING btree ("summary_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_memory_change_summaries_org_user_date" ON "memory_change_summaries" USING btree ("org_id","user_id","date");--> statement-breakpoint
CREATE INDEX "idx_memory_change_summaries_org_user_date_desc" ON "memory_change_summaries" USING btree ("org_id","user_id","date" DESC NULLS LAST);