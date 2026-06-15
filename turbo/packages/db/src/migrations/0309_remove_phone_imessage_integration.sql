ALTER TABLE "org_metadata" DROP COLUMN "agentphone_agent_id";--> statement-breakpoint
ALTER TABLE "org_metadata" DROP COLUMN "agentphone_number_id";--> statement-breakpoint
ALTER TABLE "org_metadata" DROP COLUMN "agentphone_number";--> statement-breakpoint
DROP TABLE "imessage_thread_sessions" CASCADE;--> statement-breakpoint
DROP TABLE "imessage_user_links" CASCADE;--> statement-breakpoint
DROP TABLE "pending_outbound_calls" CASCADE;--> statement-breakpoint
DROP TABLE "phone_thread_sessions" CASCADE;--> statement-breakpoint
DROP TABLE "phone_user_links" CASCADE;
