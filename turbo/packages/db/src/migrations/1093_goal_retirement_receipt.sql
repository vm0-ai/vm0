ALTER TABLE "thread_goals" ADD COLUMN "retirement_archive_event_id" uuid;--> statement-breakpoint
ALTER TABLE "thread_goals" ADD COLUMN "retirement_archive_seq_id" bigint;--> statement-breakpoint
ALTER TABLE "thread_goals" ADD CONSTRAINT "thread_goals_retirement_archive_receipt_check" CHECK (("thread_goals"."retirement_archive_event_id" IS NULL AND "thread_goals"."retirement_archive_seq_id" IS NULL)
          OR ("thread_goals"."retirement_archive_event_id" IS NOT NULL
            AND "thread_goals"."retirement_archive_seq_id" IS NOT NULL
            AND "thread_goals"."retirement_archive_seq_id" > 0
            AND "thread_goals"."retirement_archive_seq_id" <= 9007199254740991));