CREATE TABLE "morning_brief_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"brief_date" varchar(10) NOT NULL,
	"status" varchar(20) DEFAULT 'collecting' NOT NULL,
	"run_id" uuid,
	"input_key" text,
	"output_key" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "morning_brief_schedules" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"chat_thread_id" uuid,
	"next_run_at" timestamp,
	"last_success_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "morning_brief_schedules_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "org_members_metadata" ADD COLUMN "morning_brief_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "morning_brief_deliveries" ADD CONSTRAINT "morning_brief_deliveries_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "morning_brief_schedules" ADD CONSTRAINT "morning_brief_schedules_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_morning_brief_deliveries_org_user_date" ON "morning_brief_deliveries" USING btree ("org_id","user_id","brief_date");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_deliveries_run" ON "morning_brief_deliveries" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_morning_brief_schedules_next_run" ON "morning_brief_schedules" USING btree ("next_run_at") WHERE next_run_at IS NOT NULL;