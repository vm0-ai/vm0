ALTER TABLE "github_installations" DROP CONSTRAINT "github_installations_installation_id_unique";--> statement-breakpoint
ALTER TABLE "github_installations" ALTER COLUMN "installation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "github_installations" ALTER COLUMN "encrypted_access_token" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "target_type" varchar(20);--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "target_id" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX "github_installations_installation_id_unique" ON "github_installations" ("installation_id") WHERE "installation_id" IS NOT NULL;