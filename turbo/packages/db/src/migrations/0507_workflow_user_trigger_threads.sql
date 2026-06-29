CREATE TABLE "workflow_user_trigger_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"chat_thread_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" DROP CONSTRAINT "zero_workflow_triggers_chat_thread_id_chat_threads_id_fk";
--> statement-breakpoint
DROP INDEX "idx_zero_workflow_triggers_chat_thread";--> statement-breakpoint
ALTER TABLE "workflow_user_trigger_threads" ADD CONSTRAINT "workflow_user_trigger_threads_workflow_id_zero_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."zero_workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_user_trigger_threads" ADD CONSTRAINT "workflow_user_trigger_threads_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_workflow_user_trigger_threads_unique" ON "workflow_user_trigger_threads" USING btree ("org_id","user_id","workflow_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_user_trigger_threads_chat_thread" ON "workflow_user_trigger_threads" USING btree ("chat_thread_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_user_trigger_threads_workflow_user" ON "workflow_user_trigger_threads" USING btree ("workflow_id","user_id");--> statement-breakpoint
WITH ranked_trigger_threads AS (
	SELECT
		"zero_workflow_triggers"."org_id",
		"zero_workflow_triggers"."owner_user_id" AS "user_id",
		"zero_workflow_triggers"."workflow_id",
		"zero_workflow_triggers"."chat_thread_id",
		"zero_workflow_triggers"."created_at",
		"zero_workflow_triggers"."updated_at",
		ROW_NUMBER() OVER (
			PARTITION BY
				"zero_workflow_triggers"."org_id",
				"zero_workflow_triggers"."owner_user_id",
				"zero_workflow_triggers"."workflow_id"
			ORDER BY
				"zero_workflow_triggers"."updated_at" DESC,
				"zero_workflow_triggers"."created_at" DESC,
				"zero_workflow_triggers"."id" DESC
		) AS "thread_rank"
	FROM "zero_workflow_triggers"
	WHERE "zero_workflow_triggers"."chat_thread_id" IS NOT NULL
)
INSERT INTO "workflow_user_trigger_threads" (
	"org_id",
	"user_id",
	"workflow_id",
	"chat_thread_id",
	"created_at",
	"updated_at"
)
SELECT
	"org_id",
	"user_id",
	"workflow_id",
	"chat_thread_id",
	"created_at",
	"updated_at"
FROM "ranked_trigger_threads"
WHERE "thread_rank" = 1
ON CONFLICT ("org_id", "user_id", "workflow_id") DO UPDATE SET
	"chat_thread_id" = EXCLUDED."chat_thread_id",
	"updated_at" = EXCLUDED."updated_at";--> statement-breakpoint
ALTER TABLE "zero_workflow_triggers" DROP COLUMN "chat_thread_id";
