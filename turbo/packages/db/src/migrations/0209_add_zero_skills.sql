CREATE TABLE "zero_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"name" varchar(64) NOT NULL,
	"display_name" varchar(256),
	"description" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_zero_skills_org_name" ON "zero_skills" USING btree ("org_id","name");
--> statement-breakpoint
CREATE INDEX "idx_zero_skills_org" ON "zero_skills" USING btree ("org_id");
--> statement-breakpoint
ALTER TABLE "zero_agents" ADD COLUMN "custom_skills" jsonb DEFAULT '[]'::jsonb NOT NULL;
