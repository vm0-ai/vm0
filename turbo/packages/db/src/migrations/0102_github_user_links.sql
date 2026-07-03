CREATE TABLE "github_user_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_user_id" varchar(255) NOT NULL,
	"installation_id" uuid NOT NULL,
	"vm0_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "target_name" varchar(255);--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "admin_github_user_id" varchar(255);--> statement-breakpoint
ALTER TABLE "github_user_links" ADD CONSTRAINT "github_user_links_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_user_links_user_installation" ON "github_user_links" USING btree ("github_user_id","installation_id");--> statement-breakpoint
-- Data migration: for each existing installation with a user_id,
-- create a github_user_link record. We use target_id as github_user_id
-- for User-type installations since that's the GitHub user's numeric ID.
-- For Org installations, admin_github_user_id will be set via the OAuth flow.
INSERT INTO "github_user_links" ("installation_id", "github_user_id", "vm0_user_id", "created_at")
SELECT
  gi."id",
  COALESCE(gi."target_id", gi."installation_id", gi."id"::text),
  gi."user_id",
  gi."created_at"
FROM "github_installations" gi
WHERE gi."user_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "github_installations" DROP COLUMN "user_id";
