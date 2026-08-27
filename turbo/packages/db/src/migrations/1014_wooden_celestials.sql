ALTER TABLE "chat_event_snapshots" ADD COLUMN "terminal_event_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ADD COLUMN "terminal_seq_id" bigint;--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ADD CONSTRAINT "chat_event_snapshots_terminal_cursor_check" CHECK ((
          "chat_event_snapshots"."archive_schema_version" < 7
          AND "chat_event_snapshots"."terminal_event_id" IS NULL
          AND "chat_event_snapshots"."terminal_seq_id" IS NULL
        ) OR (
          "chat_event_snapshots"."archive_schema_version" >= 7
          AND (
            (
              "chat_event_snapshots"."terminal_event_id" IS NULL
              AND "chat_event_snapshots"."terminal_seq_id" = 0
            ) OR (
              "chat_event_snapshots"."terminal_event_id" IS NOT NULL
              AND "chat_event_snapshots"."terminal_seq_id" > 0
              AND "chat_event_snapshots"."terminal_seq_id" <= "chat_event_snapshots"."last_seq_id"
            )
          )
        ));--> statement-breakpoint
ALTER TABLE "chat_event_snapshots" ADD CONSTRAINT "chat_event_snapshots_canonical_projection_check" CHECK ("chat_event_snapshots"."archive_schema_version" < 7 OR "chat_event_snapshots"."projection" = 'tool-redacted');
