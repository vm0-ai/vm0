CREATE TABLE "sandbox_telemetry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_sandbox_telemetry_run_id" ON "sandbox_telemetry" USING btree ("run_id");
--> statement-breakpoint
ALTER TABLE "sandbox_telemetry" ADD CONSTRAINT "sandbox_telemetry_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;
