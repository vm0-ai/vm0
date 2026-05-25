CREATE TABLE "agent_run_queue" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"encrypted_params" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_queue" ADD CONSTRAINT "agent_run_queue_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_queue_user_created_idx" ON "agent_run_queue" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_run_queue_expires_at_idx" ON "agent_run_queue" USING btree ("expires_at");