CREATE TABLE "connector_oauth_completions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector_oauth_completions" ADD CONSTRAINT "connector_oauth_completions_connection_id_connectors_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_connector_oauth_completions_expires_at" ON "connector_oauth_completions" USING btree ("expires_at");