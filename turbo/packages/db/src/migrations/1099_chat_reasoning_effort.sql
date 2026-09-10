ALTER TABLE "agent_runs" ADD COLUMN "reasoning_effort" varchar(20);--> statement-breakpoint
ALTER TABLE "chat_thread_events" ADD COLUMN "reasoning_effort" varchar(20);--> statement-breakpoint
ALTER TABLE "chat_threads" ADD COLUMN "reasoning_effort" varchar(20);