CREATE TABLE "org_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"role" varchar(20) DEFAULT 'member' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_access_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "scopes" ADD COLUMN "clerk_org_id" text;--> statement-breakpoint
ALTER TABLE "org_access_tokens" ADD CONSTRAINT "org_access_tokens_scope_id_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."scopes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_org_access_tokens_user_scope" ON "org_access_tokens" USING btree ("user_id","scope_id");--> statement-breakpoint
CREATE INDEX "idx_scopes_clerk_org" ON "scopes" USING btree ("clerk_org_id");