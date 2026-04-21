CREATE TABLE "feature_candidate_voice_chat_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"seq" serial NOT NULL,
	"role" varchar(20) NOT NULL,
	"content" text,
	"task_id" uuid,
	"realtime_item_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_candidate_voice_chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid,
	"mode" varchar(20) DEFAULT 'chat' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"context" text,
	"context_seq" integer DEFAULT 0 NOT NULL,
	"context_version" integer DEFAULT 0 NOT NULL,
	"reasoning_status" varchar(20) DEFAULT 'idle' NOT NULL,
	"reasoning_pending" boolean DEFAULT false NOT NULL,
	"last_reasoning_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "feature_candidate_voice_chat_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" uuid,
	"call_id" text NOT NULL,
	"prompt" text NOT NULL,
	"status" varchar(20) NOT NULL,
	"result" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_items" ADD CONSTRAINT "feature_candidate_voice_chat_items_session_id_feature_candidate_voice_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."feature_candidate_voice_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_sessions" ADD CONSTRAINT "feature_candidate_voice_chat_sessions_agent_id_agent_composes_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent_composes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_tasks" ADD CONSTRAINT "feature_candidate_voice_chat_tasks_session_id_feature_candidate_voice_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."feature_candidate_voice_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feature_candidate_voice_chat_tasks" ADD CONSTRAINT "feature_candidate_voice_chat_tasks_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_fc_voice_chat_items_session_seq" ON "feature_candidate_voice_chat_items" USING btree ("session_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_fc_voice_chat_items_session_realtime" ON "feature_candidate_voice_chat_items" USING btree ("session_id","realtime_item_id");--> statement-breakpoint
CREATE INDEX "idx_fc_voice_chat_sessions_user" ON "feature_candidate_voice_chat_sessions" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_fc_voice_chat_sessions_status" ON "feature_candidate_voice_chat_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_fc_voice_chat_tasks_session_status_created" ON "feature_candidate_voice_chat_tasks" USING btree ("session_id","status","created_at");