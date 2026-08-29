ALTER TABLE "chat_event_snapshots" DROP CONSTRAINT "chat_event_snapshots_canonical_projection_check";--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" DROP CONSTRAINT "chat_event_snapshots_projection_check";--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" DROP CONSTRAINT "chat_event_snapshots_terminal_cursor_check";--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ALTER COLUMN "archive_schema_version" SET DEFAULT 7;--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ALTER COLUMN "projection" SET DEFAULT 'tool-redacted';--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ADD CONSTRAINT "chat_event_snapshots_archive_schema_version_check" CHECK ("chat_event_snapshots"."archive_schema_version" = 7);--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ADD CONSTRAINT "chat_event_snapshots_projection_check" CHECK ("chat_event_snapshots"."projection" = 'tool-redacted');--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ADD CONSTRAINT "chat_event_snapshots_terminal_cursor_check" CHECK ((
          "chat_event_snapshots"."terminal_event_id" IS NULL
          AND "chat_event_snapshots"."terminal_seq_id" = 0
        ) OR (
          "chat_event_snapshots"."terminal_event_id" IS NOT NULL
          AND "chat_event_snapshots"."terminal_seq_id" > 0
          AND "chat_event_snapshots"."terminal_seq_id" <= "chat_event_snapshots"."last_seq_id"
        ));