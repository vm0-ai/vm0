ALTER TABLE "email_thread_sessions" ADD COLUMN "agent_id" uuid;--> statement-breakpoint

UPDATE "email_thread_sessions" s
SET "agent_id" = z."id"
FROM "agent_composes" c
INNER JOIN "zero_agents" z ON z."org_id" = c."org_id" AND z."name" = c."name"
WHERE s."compose_id" = c."id" AND s."agent_id" IS NULL;--> statement-breakpoint

ALTER TABLE "email_thread_sessions" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "email_thread_sessions" ADD CONSTRAINT "email_thread_sessions_agent_id_zero_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."zero_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "email_thread_sessions" DROP CONSTRAINT "email_thread_sessions_compose_id_agent_composes_id_fk";--> statement-breakpoint

ALTER TABLE "email_thread_sessions" DROP COLUMN "compose_id";
