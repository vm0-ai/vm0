CREATE TABLE "artifact_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"public_brand" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_artifact_shares_target" ON "artifact_shares" USING btree ("target_kind","target_id");