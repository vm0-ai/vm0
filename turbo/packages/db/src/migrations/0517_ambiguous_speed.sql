CREATE TABLE "chat_output_materializations" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"processed_through_sequence" integer DEFAULT -1 NOT NULL,
	"latest_result_sequence" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_output_materializations" ADD CONSTRAINT "chat_output_materializations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;