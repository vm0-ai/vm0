ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_goal_origin_message_id_chat_messages_id_fk";--> statement-breakpoint
ALTER TABLE "chat_messages" DROP CONSTRAINT "chat_messages_goal_continuation_of_run_id_agent_runs_id_fk";--> statement-breakpoint
DROP INDEX "idx_chat_messages_goal_origin";--> statement-breakpoint
DROP INDEX "chat_messages_goal_continuation_run_unique";--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN "goal_remaining_turns";--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN "goal_origin_message_id";--> statement-breakpoint
ALTER TABLE "chat_messages" DROP COLUMN "goal_continuation_of_run_id";