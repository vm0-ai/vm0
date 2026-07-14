CREATE TYPE "public"."chat_message_queue_item_type" AS ENUM('user_message', 'workflow_event');--> statement-breakpoint
CREATE TABLE "chat_message_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"item_type" "chat_message_queue_item_type" NOT NULL,
	"chat_message_id" uuid,
	"trigger_id" uuid,
	"trigger_source" text,
	"trigger_brief" text,
	"encrypted_params" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "queue_paused_at" timestamp;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "chat_message_queue" ADD CONSTRAINT "chat_message_queue_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_queue" ADD CONSTRAINT "chat_message_queue_chat_message_id_chat_messages_id_fk" FOREIGN KEY ("chat_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message_queue" ADD CONSTRAINT "chat_message_queue_trigger_id_zero_workflow_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."zero_workflow_triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_message_queue_thread_created" ON "chat_message_queue" USING btree ("chat_thread_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_chat_message_queue_trigger" ON "chat_message_queue" USING btree ("trigger_id") WHERE "chat_message_queue"."trigger_id" IS NOT NULL;