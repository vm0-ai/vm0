CREATE TABLE "pi_run_handoffs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"transcript_version" integer NOT NULL,
	"after_ordinal" integer NOT NULL,
	"message_id" text NOT NULL,
	"from_environment" text NOT NULL,
	"to_environment" text NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pi_run_handoffs" ADD CONSTRAINT "pi_run_handoffs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;