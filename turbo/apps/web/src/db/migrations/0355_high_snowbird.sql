INSERT INTO "chat_messages" (
	"id",
	"chat_thread_id",
	"role",
	"content",
	"attach_files",
	"created_at"
)
SELECT
	COALESCE("pending_message_client_id", gen_random_uuid()),
	"id",
	'user',
	"pending_message_content",
	(
		SELECT jsonb_agg(attachment ->> 'id')
		FROM jsonb_array_elements("pending_message_attachments") AS attachment
		WHERE attachment ->> 'id' IS NOT NULL
	),
	COALESCE("pending_message_created_at", now())
FROM "chat_threads"
WHERE
	"pending_message_created_at" IS NOT NULL
	AND (
		COALESCE("pending_message_content", '') <> ''
		OR (
			"pending_message_attachments" IS NOT NULL
			AND jsonb_array_length("pending_message_attachments") > 0
		)
	)
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "pending_message_content";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "pending_message_attachments";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "pending_message_created_at";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "pending_message_updated_at";--> statement-breakpoint
ALTER TABLE "chat_threads" DROP COLUMN "pending_message_client_id";
