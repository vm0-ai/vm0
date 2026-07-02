CREATE TABLE "chat_thread_snapshots" (
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"latest_event_id" uuid,
	"chat_threads" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chat_thread_snapshots_user_id_org_id_pk" PRIMARY KEY("user_id","org_id")
);
--> statement-breakpoint
WITH "snapshot_scopes" AS (
	SELECT "user_id", "org_id"
	FROM "org_members_cache"
	UNION
	SELECT "user_id", "org_id"
	FROM "org_members_metadata"
	UNION
	SELECT "chat_threads"."user_id", "agent_composes"."org_id"
	FROM "chat_threads"
	INNER JOIN "agent_composes"
		ON "agent_composes"."id" = "chat_threads"."agent_compose_id"
),
"snapshot_rows" AS (
	SELECT
		"snapshot_scopes"."user_id",
		"snapshot_scopes"."org_id",
		"latest_event"."id" AS "latest_event_id",
		COALESCE("thread_projection"."chat_threads", '[]'::jsonb) AS "chat_threads"
	FROM "snapshot_scopes"
	LEFT JOIN LATERAL (
		SELECT jsonb_agg(
			jsonb_build_object(
				'id', "chat_threads"."id",
				'agentId', "chat_threads"."agent_compose_id",
				'title', "chat_threads"."title",
				'sortAt', "chat_threads"."last_message_at",
				'createdAt', "chat_threads"."created_at",
				'updatedAt', "chat_threads"."updated_at",
				'pinnedAt', "chat_threads"."pinned_at",
				'renamedAt', "chat_threads"."renamed_at"
			)
			ORDER BY
				"chat_threads"."pinned_at" DESC NULLS LAST,
				"chat_threads"."last_message_at" DESC,
				"chat_threads"."id" DESC
		) AS "chat_threads"
		FROM "chat_threads"
		INNER JOIN "agent_composes"
			ON "agent_composes"."id" = "chat_threads"."agent_compose_id"
		WHERE "chat_threads"."user_id" = "snapshot_scopes"."user_id"
			AND "agent_composes"."org_id" = "snapshot_scopes"."org_id"
	) AS "thread_projection" ON true
	LEFT JOIN LATERAL (
		SELECT "chat_thread_events"."id"
		FROM "chat_thread_events"
		WHERE "chat_thread_events"."user_id" = "snapshot_scopes"."user_id"
			AND "chat_thread_events"."org_id" = "snapshot_scopes"."org_id"
		ORDER BY "chat_thread_events"."created_at" DESC, "chat_thread_events"."id" DESC
		LIMIT 1
	) AS "latest_event" ON true
)
INSERT INTO "chat_thread_snapshots" (
	"user_id",
	"org_id",
	"latest_event_id",
	"chat_threads",
	"created_at",
	"updated_at"
)
SELECT
	"user_id",
	"org_id",
	"latest_event_id",
	"chat_threads",
	now(),
	now()
FROM "snapshot_rows";
