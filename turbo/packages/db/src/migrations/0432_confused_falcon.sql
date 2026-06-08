ALTER TABLE "chat_messages" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "schedule_title" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_schedule_id_zero_agent_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."zero_agent_schedules"("id") ON DELETE set null ON UPDATE no action;