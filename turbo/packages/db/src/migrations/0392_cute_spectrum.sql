CREATE TABLE "github_label_listeners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"label_name" varchar(255) NOT NULL,
	"label_name_normalized" varchar(255) NOT NULL,
	"trigger_mode" varchar(32) DEFAULT 'created_by_me' NOT NULL,
	"prompt" text NOT NULL,
	"compose_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "org_id" text;--> statement-breakpoint
UPDATE "github_installations"
SET "org_id" = "agent_composes"."org_id"
FROM "agent_composes"
WHERE "github_installations"."default_compose_id" = "agent_composes"."id";--> statement-breakpoint
ALTER TABLE "github_installations" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "github_label_listeners" ADD CONSTRAINT "github_label_listeners_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_label_listeners" ADD CONSTRAINT "github_label_listeners_compose_id_agent_composes_id_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."agent_composes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_label_listeners_installation_label" ON "github_label_listeners" USING btree ("installation_id","label_name_normalized");--> statement-breakpoint
CREATE INDEX "idx_github_label_listeners_org" ON "github_label_listeners" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_github_label_listeners_installation" ON "github_label_listeners" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "idx_github_installations_org" ON "github_installations" USING btree ("org_id");
