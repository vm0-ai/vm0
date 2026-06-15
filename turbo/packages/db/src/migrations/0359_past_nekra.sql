ALTER TABLE "chat_messages" ADD COLUMN "goal_remaining_turns" integer;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "goal_origin_message_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "goal_continuation_of_run_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_goal_origin_message_id_chat_messages_id_fk" FOREIGN KEY ("goal_origin_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_goal_continuation_of_run_id_agent_runs_id_fk" FOREIGN KEY ("goal_continuation_of_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_messages_goal_origin" ON "chat_messages" USING btree ("goal_origin_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_goal_continuation_run_unique" ON "chat_messages" USING btree ("goal_continuation_of_run_id");