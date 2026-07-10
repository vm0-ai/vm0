CREATE TABLE "zero_workflow_queue_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"trigger_id" uuid NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"trigger_source" text NOT NULL,
	"trigger_brief" text,
	"encrypted_params" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_user_trigger_threads" ADD COLUMN "queue_paused_at" timestamp;--> statement-breakpoint
ALTER TABLE "workflow_user_trigger_threads" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "zero_workflow_queue_events" ADD CONSTRAINT "zero_workflow_queue_events_workflow_id_zero_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."zero_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zero_workflow_queue_events" ADD CONSTRAINT "zero_workflow_queue_events_trigger_id_zero_workflow_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."zero_workflow_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zero_workflow_queue_events" ADD CONSTRAINT "zero_workflow_queue_events_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_zero_workflow_queue_events_fifo" ON "zero_workflow_queue_events" USING btree ("org_id","user_id","workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_zero_workflow_queue_events_trigger" ON "zero_workflow_queue_events" USING btree ("trigger_id");--> statement-breakpoint
CREATE INDEX "idx_zero_workflow_queue_events_chat_thread" ON "zero_workflow_queue_events" USING btree ("chat_thread_id");