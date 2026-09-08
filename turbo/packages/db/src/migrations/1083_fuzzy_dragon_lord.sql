CREATE TABLE "run_output_legacy_pi_events" (
	"run_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"serialized_event" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "run_output_legacy_pi_events_run_id_sequence_number_pk" PRIMARY KEY("run_id","sequence_number")
);
--> statement-breakpoint
ALTER TABLE "run_output_legacy_pi_events" ADD CONSTRAINT "run_output_legacy_pi_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;