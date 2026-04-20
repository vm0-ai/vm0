CREATE TABLE "chat_thread_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"agent_compose_id" uuid NOT NULL,
	"title" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_runs" ADD CONSTRAINT "chat_thread_runs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_agent_compose_id_agent_composes_id_fk" FOREIGN KEY ("agent_compose_id") REFERENCES "public"."agent_composes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_thread_runs_unique" ON "chat_thread_runs" USING btree ("chat_thread_id","run_id");--> statement-breakpoint
CREATE INDEX "idx_chat_thread_runs_thread" ON "chat_thread_runs" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE INDEX "idx_chat_threads_user_compose_updated" ON "chat_threads" USING btree ("user_id","agent_compose_id","updated_at" DESC NULLS LAST);