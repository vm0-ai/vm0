CREATE TABLE "connector_oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text NOT NULL,
	"type" varchar(50) NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"session_id" uuid,
	"code_verifier" text,
	"oauth_context" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connector_oauth_states_state" ON "connector_oauth_states" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_connector_oauth_states_user_org" ON "connector_oauth_states" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_connector_oauth_states_expires_at" ON "connector_oauth_states" USING btree ("expires_at");