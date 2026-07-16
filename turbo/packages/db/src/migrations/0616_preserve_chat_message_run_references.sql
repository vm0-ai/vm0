ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_interrupts_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_revokes_message_id_chat_messages_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_revokes_message_id_chat_messages_id_fk" FOREIGN KEY ("revokes_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE no action ON UPDATE no action;
