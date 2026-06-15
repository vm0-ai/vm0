CREATE TABLE "runner_state" (
	"runner_id" uuid PRIMARY KEY NOT NULL,
	"runner_name" varchar(255) NOT NULL,
	"runner_group" varchar(255) NOT NULL,
	"profiles" jsonb NOT NULL,
	"total_vcpu" integer DEFAULT 0 NOT NULL,
	"total_memory_mb" integer DEFAULT 0 NOT NULL,
	"max_concurrent" integer DEFAULT 0 NOT NULL,
	"allocated_vcpu" integer DEFAULT 0 NOT NULL,
	"allocated_memory_mb" integer DEFAULT 0 NOT NULL,
	"running_count" integer DEFAULT 0 NOT NULL,
	"held_sessions" jsonb NOT NULL,
	"mode" varchar(20) DEFAULT 'running' NOT NULL,
	"last_seen_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "runner_state_group_idx" ON "runner_state" USING btree ("runner_group");--> statement-breakpoint
CREATE INDEX "runner_state_last_seen_idx" ON "runner_state" USING btree ("last_seen_at");