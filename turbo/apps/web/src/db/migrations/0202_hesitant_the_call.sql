CREATE TABLE "zero_agent_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"chat_messages" jsonb DEFAULT '[]'::jsonb
);
--> statement-breakpoint
ALTER TABLE "zero_agent_sessions" ADD CONSTRAINT "zero_agent_sessions_id_agent_sessions_id_fk" FOREIGN KEY ("id") REFERENCES "public"."agent_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "zero_agent_sessions" ("id", "chat_messages")
  SELECT "id", COALESCE("chat_messages", '[]'::jsonb)
  FROM "agent_sessions";--> statement-breakpoint
ALTER TABLE "agent_sessions" DROP COLUMN "chat_messages";