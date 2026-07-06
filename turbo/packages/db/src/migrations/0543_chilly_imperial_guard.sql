CREATE TABLE "agent_run_custom_connector_auth_refs" (
	"run_id" uuid NOT NULL,
	"secret_name" varchar(255) NOT NULL,
	"connector_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"key" varchar(64) NOT NULL,
	"encrypted_value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_run_custom_connector_auth_refs_run_id_secret_name_pk" PRIMARY KEY("run_id","secret_name")
);
--> statement-breakpoint
ALTER TABLE "agent_run_custom_connector_auth_refs" ADD CONSTRAINT "agent_run_custom_connector_auth_refs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_run_custom_connector_auth_refs_expires" ON "agent_run_custom_connector_auth_refs" USING btree ("expires_at");