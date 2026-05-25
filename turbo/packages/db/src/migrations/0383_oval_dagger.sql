CREATE TABLE "run_built_in_admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" varchar(30) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_built_in_admissions" ADD CONSTRAINT "run_built_in_admissions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_run_builtin_admissions_run_status" ON "run_built_in_admissions" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "idx_run_builtin_admissions_run_created" ON "run_built_in_admissions" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_run_builtin_admissions_expires_at" ON "run_built_in_admissions" USING btree ("expires_at");