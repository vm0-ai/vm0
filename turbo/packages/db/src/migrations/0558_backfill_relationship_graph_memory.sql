WITH existing_alias_targets AS (
	SELECT DISTINCT ON ("relationship_entities"."id")
		"relationship_entities"."id" AS "relationship_entity_id",
		"memory_entity_aliases"."entity_id" AS "graph_entity_id",
		"relationship_entities"."org_id",
		"relationship_entities"."user_id",
		"relationship_entities"."identity_key"
	FROM "relationship_entities"
	INNER JOIN "memory_entity_aliases"
		ON "memory_entity_aliases"."org_id" = "relationship_entities"."org_id"
		AND "memory_entity_aliases"."user_id" = "relationship_entities"."user_id"
		AND (
			(
				"relationship_entities"."primary_email" IS NOT NULL
				AND "memory_entity_aliases"."alias_type" = 'email'
				AND "memory_entity_aliases"."alias_value" = "relationship_entities"."primary_email"
			)
			OR (
				"relationship_entities"."domain" IS NOT NULL
				AND "memory_entity_aliases"."alias_type" = 'domain'
				AND "memory_entity_aliases"."alias_value" = "relationship_entities"."domain"
			)
		)
	WHERE NOT EXISTS (
		SELECT 1
		FROM "memory_entity_aliases" AS "relationship_identity_aliases"
		WHERE "relationship_identity_aliases"."org_id" = "relationship_entities"."org_id"
			AND "relationship_identity_aliases"."user_id" = "relationship_entities"."user_id"
			AND "relationship_identity_aliases"."alias_type" = 'relationship_identity'
			AND "relationship_identity_aliases"."alias_value" = "relationship_entities"."identity_key"
	)
	ORDER BY
		"relationship_entities"."id",
		CASE "memory_entity_aliases"."alias_type"
			WHEN 'email' THEN 0
			ELSE 1
		END
)
INSERT INTO "memory_entity_aliases" (
	"org_id",
	"user_id",
	"entity_id",
	"provider",
	"alias_type",
	"alias_value",
	"created_at",
	"updated_at"
)
SELECT
	"org_id",
	"user_id",
	"graph_entity_id",
	NULL,
	'relationship_identity',
	"identity_key",
	now(),
	now()
FROM existing_alias_targets
ON CONFLICT DO NOTHING;
--> statement-breakpoint
WITH missing_relationship_entities AS (
	SELECT
		gen_random_uuid() AS "graph_entity_id",
		"relationship_entities"."org_id",
		"relationship_entities"."user_id",
		"relationship_entities"."type",
		"relationship_entities"."identity_key",
		"relationship_entities"."display_name",
		"relationship_entities"."created_at",
		"relationship_entities"."updated_at"
	FROM "relationship_entities"
	WHERE NOT EXISTS (
		SELECT 1
		FROM "memory_entity_aliases"
		WHERE "memory_entity_aliases"."org_id" = "relationship_entities"."org_id"
			AND "memory_entity_aliases"."user_id" = "relationship_entities"."user_id"
			AND "memory_entity_aliases"."alias_type" = 'relationship_identity'
			AND "memory_entity_aliases"."alias_value" = "relationship_entities"."identity_key"
	)
),
inserted_memory_entities AS (
	INSERT INTO "memory_entities" (
		"id",
		"org_id",
		"user_id",
		"type",
		"display_name",
		"created_at",
		"updated_at"
	)
	SELECT
		"graph_entity_id",
		"org_id",
		"user_id",
		"type",
		"display_name",
		"created_at",
		"updated_at"
	FROM missing_relationship_entities
	ON CONFLICT DO NOTHING
	RETURNING "id"
)
INSERT INTO "memory_entity_aliases" (
	"org_id",
	"user_id",
	"entity_id",
	"provider",
	"alias_type",
	"alias_value",
	"created_at",
	"updated_at"
)
SELECT
	"missing_relationship_entities"."org_id",
	"missing_relationship_entities"."user_id",
	"missing_relationship_entities"."graph_entity_id",
	NULL,
	'relationship_identity',
	"missing_relationship_entities"."identity_key",
	now(),
	now()
FROM missing_relationship_entities
INNER JOIN inserted_memory_entities
	ON "inserted_memory_entities"."id" = "missing_relationship_entities"."graph_entity_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "memory_entities"
SET
	"type" = "relationship_entities"."type",
	"display_name" = "relationship_entities"."display_name",
	"updated_at" = now()
FROM "memory_entity_aliases"
INNER JOIN "relationship_entities"
	ON "relationship_entities"."org_id" = "memory_entity_aliases"."org_id"
	AND "relationship_entities"."user_id" = "memory_entity_aliases"."user_id"
	AND "relationship_entities"."identity_key" = "memory_entity_aliases"."alias_value"
WHERE "memory_entities"."id" = "memory_entity_aliases"."entity_id"
	AND "memory_entity_aliases"."alias_type" = 'relationship_identity';
--> statement-breakpoint
INSERT INTO "memory_entity_aliases" (
	"org_id",
	"user_id",
	"entity_id",
	"provider",
	"alias_type",
	"alias_value",
	"created_at",
	"updated_at"
)
SELECT
	"relationship_entities"."org_id",
	"relationship_entities"."user_id",
	"memory_entity_aliases"."entity_id",
	NULL,
	'email',
	"relationship_entities"."primary_email",
	now(),
	now()
FROM "relationship_entities"
INNER JOIN "memory_entity_aliases"
	ON "memory_entity_aliases"."org_id" = "relationship_entities"."org_id"
	AND "memory_entity_aliases"."user_id" = "relationship_entities"."user_id"
	AND "memory_entity_aliases"."alias_type" = 'relationship_identity'
	AND "memory_entity_aliases"."alias_value" = "relationship_entities"."identity_key"
WHERE "relationship_entities"."primary_email" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "memory_entity_aliases" (
	"org_id",
	"user_id",
	"entity_id",
	"provider",
	"alias_type",
	"alias_value",
	"created_at",
	"updated_at"
)
SELECT
	"relationship_entities"."org_id",
	"relationship_entities"."user_id",
	"memory_entity_aliases"."entity_id",
	NULL,
	'domain',
	"relationship_entities"."domain",
	now(),
	now()
FROM "relationship_entities"
INNER JOIN "memory_entity_aliases"
	ON "memory_entity_aliases"."org_id" = "relationship_entities"."org_id"
	AND "memory_entity_aliases"."user_id" = "relationship_entities"."user_id"
	AND "memory_entity_aliases"."alias_type" = 'relationship_identity'
	AND "memory_entity_aliases"."alias_value" = "relationship_entities"."identity_key"
WHERE "relationship_entities"."domain" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "memory_entity_aliases" (
	"org_id",
	"user_id",
	"entity_id",
	"provider",
	"alias_type",
	"alias_value",
	"created_at",
	"updated_at"
)
SELECT
	"relationship_entities"."org_id",
	"relationship_entities"."user_id",
	"memory_entity_aliases"."entity_id",
	'slack',
	'slack_channel',
	regexp_replace(
		"relationship_entities"."identity_key",
		'^organization:slack:([^:]+):(.+)$',
		'\1:\2'
	),
	now(),
	now()
FROM "relationship_entities"
INNER JOIN "memory_entity_aliases"
	ON "memory_entity_aliases"."org_id" = "relationship_entities"."org_id"
	AND "memory_entity_aliases"."user_id" = "relationship_entities"."user_id"
	AND "memory_entity_aliases"."alias_type" = 'relationship_identity'
	AND "memory_entity_aliases"."alias_value" = "relationship_entities"."identity_key"
WHERE "relationship_entities"."identity_key" ~ '^organization:slack:[^:]+:.+$'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
WITH relationship_profile_base AS (
	SELECT
		"relationship_states"."org_id",
		"relationship_states"."user_id",
		"memory_entity_aliases"."entity_id",
		"relationship_states"."relationship_type",
		"relationship_states"."status",
		"relationship_states"."summary",
		"relationship_states"."last_interaction_at",
		"relationship_states"."created_at",
		"relationship_states"."updated_at",
		count("relationship_items"."id")::int AS "source_memory_count"
	FROM "relationship_states"
	INNER JOIN "relationship_entities"
		ON "relationship_entities"."id" = "relationship_states"."entity_id"
	INNER JOIN "memory_entity_aliases"
		ON "memory_entity_aliases"."org_id" = "relationship_entities"."org_id"
		AND "memory_entity_aliases"."user_id" = "relationship_entities"."user_id"
		AND "memory_entity_aliases"."alias_type" = 'relationship_identity'
		AND "memory_entity_aliases"."alias_value" = "relationship_entities"."identity_key"
	LEFT JOIN "relationship_items"
		ON "relationship_items"."relationship_state_id" = "relationship_states"."id"
	GROUP BY
		"relationship_states"."org_id",
		"relationship_states"."user_id",
		"memory_entity_aliases"."entity_id",
		"relationship_states"."relationship_type",
		"relationship_states"."status",
		"relationship_states"."summary",
		"relationship_states"."last_interaction_at",
		"relationship_states"."created_at",
		"relationship_states"."updated_at"
),
relationship_profile_rows AS (
	SELECT
		"org_id",
		"user_id",
		"entity_id",
		'relationship_summary' AS "section",
		"summary" AS "content",
		"source_memory_count",
		"created_at",
		"updated_at"
	FROM relationship_profile_base
	UNION ALL
	SELECT
		"org_id",
		"user_id",
		"entity_id",
		'relationship_type',
		"relationship_type",
		"source_memory_count",
		"created_at",
		"updated_at"
	FROM relationship_profile_base
	UNION ALL
	SELECT
		"org_id",
		"user_id",
		"entity_id",
		'relationship_status',
		"status",
		"source_memory_count",
		"created_at",
		"updated_at"
	FROM relationship_profile_base
	UNION ALL
	SELECT
		"org_id",
		"user_id",
		"entity_id",
		'relationship_last_interaction_at',
		to_char(
			"last_interaction_at" AT TIME ZONE 'UTC',
			'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
		),
		"source_memory_count",
		"created_at",
		"updated_at"
	FROM relationship_profile_base
	WHERE "last_interaction_at" IS NOT NULL
)
INSERT INTO "memory_profiles" (
	"org_id",
	"user_id",
	"entity_id",
	"section",
	"content",
	"source_memory_count",
	"created_at",
	"updated_at"
)
SELECT
	"org_id",
	"user_id",
	"entity_id",
	"section",
	"content",
	"source_memory_count",
	"created_at",
	"updated_at"
FROM relationship_profile_rows
WHERE "content" IS NOT NULL
	AND "content" <> ''
ON CONFLICT ("entity_id", "section") DO UPDATE
SET
	"content" = EXCLUDED."content",
	"source_memory_count" = EXCLUDED."source_memory_count",
	"updated_at" = now();
--> statement-breakpoint
WITH relationship_source_rows AS (
	SELECT
		"relationship_item_sources"."org_id",
		"relationship_item_sources"."user_id",
		"relationship_item_sources"."provider",
		CASE "relationship_item_sources"."provider"
			WHEN 'gmail' THEN 'gmail_message'
			ELSE 'slack_message'
		END AS "source_type",
		CASE
			WHEN "relationship_item_sources"."external_id" ~ ':(key_fact|preference|open_loop):[0-9a-f]{16,64}$' THEN regexp_replace(
				"relationship_item_sources"."external_id",
				':(key_fact|preference|open_loop):[0-9a-f]{16,64}$',
				''
			)
			ELSE "relationship_item_sources"."external_id"
		END AS "source_external_id",
		"relationship_item_sources"."connector_id",
		"relationship_item_sources"."occurred_at",
		"relationship_item_sources"."thread_id",
		"relationship_item_sources"."message_id",
		"relationship_item_sources"."created_at"
	FROM "relationship_item_sources"
	UNION ALL
	SELECT
		"relationship_interactions"."org_id",
		"relationship_interactions"."user_id",
		"relationship_interactions"."provider",
		CASE "relationship_interactions"."provider"
			WHEN 'gmail' THEN 'gmail_message'
			ELSE 'slack_message'
		END AS "source_type",
		"relationship_interactions"."external_id" AS "source_external_id",
		"relationship_interactions"."connector_id",
		"relationship_interactions"."occurred_at",
		"relationship_interactions"."thread_id",
		"relationship_interactions"."message_id",
		"relationship_interactions"."created_at"
	FROM "relationship_interactions"
),
relationship_sources AS (
	SELECT
		"org_id",
		"user_id",
		"provider",
		"source_type",
		"source_external_id",
		min("connector_id"::text)::uuid AS "connector_id",
		max("occurred_at") AS "occurred_at",
		jsonb_strip_nulls(jsonb_build_object(
			'threadId', max("thread_id"),
			'messageId', max("message_id"),
			'messageTs', CASE
				WHEN "provider" = 'slack' THEN max("message_id")
				ELSE NULL
			END,
			'direction', 'unknown',
			'reason', 'relationship_memory_backfill'
		)) AS "metadata",
		max("created_at") AS "created_at"
	FROM relationship_source_rows
	GROUP BY
		"org_id",
		"user_id",
		"provider",
		"source_type",
		"source_external_id"
)
INSERT INTO "memory_sources" (
	"org_id",
	"user_id",
	"provider",
	"source_type",
	"external_id",
	"connector_id",
	"occurred_at",
	"title",
	"content_hash",
	"metadata",
	"created_at",
	"updated_at"
)
SELECT
	"org_id",
	"user_id",
	"provider",
	"source_type",
	"source_external_id",
	"connector_id",
	"occurred_at",
	'Relationship memory source',
	NULL,
	"metadata",
	coalesce("created_at", now()),
	now()
FROM relationship_sources
ON CONFLICT ("org_id", "user_id", "provider", "external_id") DO UPDATE
SET
	"source_type" = EXCLUDED."source_type",
	"connector_id" = coalesce("memory_sources"."connector_id", EXCLUDED."connector_id"),
	"occurred_at" = coalesce("memory_sources"."occurred_at", EXCLUDED."occurred_at"),
	"metadata" = "memory_sources"."metadata" || EXCLUDED."metadata",
	"updated_at" = now();
--> statement-breakpoint
WITH relationship_memory_rows AS (
	WITH relationship_items_with_status AS (
		SELECT
			"relationship_items"."id",
			"relationship_items"."org_id",
			"relationship_items"."user_id",
			"relationship_items"."relationship_state_id",
			"relationship_items"."kind",
			CASE
				WHEN "relationship_items"."archived_at" IS NOT NULL OR "relationship_states"."status" = 'archived' THEN 'archived'
				ELSE 'active'
			END AS "status",
			"relationship_items"."text",
			"relationship_items"."confidence",
			"relationship_items"."last_seen_at",
			"relationship_items"."created_at",
			"relationship_items"."updated_at"
		FROM "relationship_items"
		INNER JOIN "relationship_states"
			ON "relationship_states"."id" = "relationship_items"."relationship_state_id"
	)
	SELECT
		"relationship_items_with_status"."org_id",
		"relationship_items_with_status"."user_id",
		"memory_entity_aliases"."entity_id",
		"relationship_items_with_status"."kind",
		"relationship_items_with_status"."status",
		"relationship_items_with_status"."text",
		"relationship_items_with_status"."confidence",
		count("relationship_item_sources"."id")::int AS "source_count",
		"relationship_items_with_status"."last_seen_at",
		"relationship_items_with_status"."created_at",
		"relationship_items_with_status"."updated_at"
	FROM relationship_items_with_status
	INNER JOIN "relationship_states"
		ON "relationship_states"."id" = "relationship_items_with_status"."relationship_state_id"
	INNER JOIN "relationship_entities"
		ON "relationship_entities"."id" = "relationship_states"."entity_id"
	INNER JOIN "memory_entity_aliases"
		ON "memory_entity_aliases"."org_id" = "relationship_entities"."org_id"
		AND "memory_entity_aliases"."user_id" = "relationship_entities"."user_id"
		AND "memory_entity_aliases"."alias_type" = 'relationship_identity'
		AND "memory_entity_aliases"."alias_value" = "relationship_entities"."identity_key"
	LEFT JOIN "relationship_item_sources"
		ON "relationship_item_sources"."relationship_item_id" = "relationship_items_with_status"."id"
	GROUP BY
		"relationship_items_with_status"."org_id",
		"relationship_items_with_status"."user_id",
		"memory_entity_aliases"."entity_id",
		"relationship_items_with_status"."kind",
		"relationship_items_with_status"."status",
		"relationship_items_with_status"."text",
		"relationship_items_with_status"."confidence",
		"relationship_items_with_status"."last_seen_at",
		"relationship_items_with_status"."created_at",
		"relationship_items_with_status"."updated_at"
)
INSERT INTO "memories" (
	"org_id",
	"user_id",
	"entity_id",
	"kind",
	"status",
	"text",
	"confidence",
	"source_count",
	"last_seen_at",
	"created_at",
	"updated_at"
)
SELECT
	"org_id",
	"user_id",
	"entity_id",
	"kind",
	"status",
	"text",
	"confidence",
	"source_count",
	"last_seen_at",
	"created_at",
	"updated_at"
FROM relationship_memory_rows
WHERE NOT EXISTS (
	SELECT 1
	FROM "memories"
	WHERE "memories"."org_id" = "relationship_memory_rows"."org_id"
		AND "memories"."user_id" = "relationship_memory_rows"."user_id"
		AND "memories"."entity_id" = "relationship_memory_rows"."entity_id"
		AND "memories"."kind" = "relationship_memory_rows"."kind"
		AND "memories"."status" = "relationship_memory_rows"."status"
		AND "memories"."text" = "relationship_memory_rows"."text"
);
--> statement-breakpoint
WITH relationship_sources AS (
	SELECT
		"relationship_item_sources"."relationship_item_id",
		"relationship_item_sources"."org_id",
		"relationship_item_sources"."user_id",
		"relationship_item_sources"."provider",
		CASE
			WHEN "relationship_item_sources"."external_id" ~ ':(key_fact|preference|open_loop):[0-9a-f]{16,64}$' THEN regexp_replace(
				"relationship_item_sources"."external_id",
				':(key_fact|preference|open_loop):[0-9a-f]{16,64}$',
				''
			)
			ELSE "relationship_item_sources"."external_id"
		END AS "source_external_id",
		"relationship_item_sources"."created_at"
	FROM "relationship_item_sources"
)
INSERT INTO "memory_source_links" (
	"org_id",
	"user_id",
	"memory_id",
	"source_id",
	"created_at"
)
SELECT DISTINCT
	"relationship_items"."org_id",
	"relationship_items"."user_id",
	"memories"."id",
	"memory_sources"."id",
	coalesce("relationship_sources"."created_at", now())
FROM "relationship_items"
INNER JOIN "relationship_sources"
	ON "relationship_sources"."relationship_item_id" = "relationship_items"."id"
INNER JOIN "relationship_states"
	ON "relationship_states"."id" = "relationship_items"."relationship_state_id"
INNER JOIN "relationship_entities"
	ON "relationship_entities"."id" = "relationship_states"."entity_id"
INNER JOIN "memory_entity_aliases"
	ON "memory_entity_aliases"."org_id" = "relationship_entities"."org_id"
	AND "memory_entity_aliases"."user_id" = "relationship_entities"."user_id"
	AND "memory_entity_aliases"."alias_type" = 'relationship_identity'
	AND "memory_entity_aliases"."alias_value" = "relationship_entities"."identity_key"
INNER JOIN "memories"
	ON "memories"."org_id" = "relationship_items"."org_id"
	AND "memories"."user_id" = "relationship_items"."user_id"
	AND "memories"."entity_id" = "memory_entity_aliases"."entity_id"
	AND "memories"."kind" = "relationship_items"."kind"
	AND "memories"."text" = "relationship_items"."text"
	AND "memories"."status" = CASE
		WHEN "relationship_items"."archived_at" IS NOT NULL OR "relationship_states"."status" = 'archived' THEN 'archived'
		ELSE 'active'
	END
INNER JOIN "memory_sources"
	ON "memory_sources"."org_id" = "relationship_sources"."org_id"
	AND "memory_sources"."user_id" = "relationship_sources"."user_id"
	AND "memory_sources"."provider" = "relationship_sources"."provider"
	AND "memory_sources"."external_id" = "relationship_sources"."source_external_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
WITH relationship_interaction_memory_rows AS (
	SELECT
		"relationship_interactions"."org_id",
		"relationship_interactions"."user_id",
		"memory_entity_aliases"."entity_id",
		'recent_context' AS "kind",
		'active' AS "status",
		"relationship_interactions"."snippet" AS "text",
		80 AS "confidence",
		0 AS "source_count",
		"relationship_interactions"."occurred_at" AS "last_seen_at",
		"relationship_interactions"."created_at",
		"relationship_interactions"."created_at" AS "updated_at"
	FROM "relationship_interactions"
	INNER JOIN "relationship_states"
		ON "relationship_states"."id" = "relationship_interactions"."relationship_state_id"
	INNER JOIN "relationship_entities"
		ON "relationship_entities"."id" = "relationship_states"."entity_id"
	INNER JOIN "memory_entity_aliases"
		ON "memory_entity_aliases"."org_id" = "relationship_entities"."org_id"
		AND "memory_entity_aliases"."user_id" = "relationship_entities"."user_id"
		AND "memory_entity_aliases"."alias_type" = 'relationship_identity'
		AND "memory_entity_aliases"."alias_value" = "relationship_entities"."identity_key"
)
INSERT INTO "memories" (
	"org_id",
	"user_id",
	"entity_id",
	"kind",
	"status",
	"text",
	"confidence",
	"source_count",
	"last_seen_at",
	"created_at",
	"updated_at"
)
SELECT
	"org_id",
	"user_id",
	"entity_id",
	"kind",
	"status",
	"text",
	"confidence",
	"source_count",
	"last_seen_at",
	"created_at",
	"updated_at"
FROM relationship_interaction_memory_rows
WHERE NOT EXISTS (
	SELECT 1
	FROM "memories"
	WHERE "memories"."org_id" = "relationship_interaction_memory_rows"."org_id"
		AND "memories"."user_id" = "relationship_interaction_memory_rows"."user_id"
		AND "memories"."entity_id" = "relationship_interaction_memory_rows"."entity_id"
		AND "memories"."kind" = 'recent_context'
		AND "memories"."status" = 'active'
		AND "memories"."text" = "relationship_interaction_memory_rows"."text"
		AND "memories"."last_seen_at" = "relationship_interaction_memory_rows"."last_seen_at"
);
--> statement-breakpoint
INSERT INTO "memory_source_links" (
	"org_id",
	"user_id",
	"memory_id",
	"source_id",
	"created_at"
)
SELECT DISTINCT
	"relationship_interactions"."org_id",
	"relationship_interactions"."user_id",
	"memories"."id",
	"memory_sources"."id",
	"relationship_interactions"."created_at"
FROM "relationship_interactions"
INNER JOIN "relationship_states"
	ON "relationship_states"."id" = "relationship_interactions"."relationship_state_id"
INNER JOIN "relationship_entities"
	ON "relationship_entities"."id" = "relationship_states"."entity_id"
INNER JOIN "memory_entity_aliases"
	ON "memory_entity_aliases"."org_id" = "relationship_entities"."org_id"
	AND "memory_entity_aliases"."user_id" = "relationship_entities"."user_id"
	AND "memory_entity_aliases"."alias_type" = 'relationship_identity'
	AND "memory_entity_aliases"."alias_value" = "relationship_entities"."identity_key"
INNER JOIN "memories"
	ON "memories"."org_id" = "relationship_interactions"."org_id"
	AND "memories"."user_id" = "relationship_interactions"."user_id"
	AND "memories"."entity_id" = "memory_entity_aliases"."entity_id"
	AND "memories"."kind" = 'recent_context'
	AND "memories"."status" = 'active'
	AND "memories"."text" = "relationship_interactions"."snippet"
	AND "memories"."last_seen_at" = "relationship_interactions"."occurred_at"
INNER JOIN "memory_sources"
	ON "memory_sources"."org_id" = "relationship_interactions"."org_id"
	AND "memory_sources"."user_id" = "relationship_interactions"."user_id"
	AND "memory_sources"."provider" = "relationship_interactions"."provider"
	AND "memory_sources"."external_id" = "relationship_interactions"."external_id"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "memories"
SET
	"source_count" = (
		SELECT count(*)::int
		FROM "memory_source_links"
		WHERE "memory_source_links"."memory_id" = "memories"."id"
	),
	"updated_at" = now()
WHERE "memories"."kind" IN ('key_fact', 'preference', 'open_loop', 'recent_context')
	AND EXISTS (
		SELECT 1
		FROM "memory_entity_aliases"
		WHERE "memory_entity_aliases"."entity_id" = "memories"."entity_id"
			AND "memory_entity_aliases"."alias_type" = 'relationship_identity'
	);
--> statement-breakpoint
DROP TABLE "relationship_item_sources";
--> statement-breakpoint
DROP TABLE "relationship_interactions";
--> statement-breakpoint
DROP TABLE "relationship_items";
--> statement-breakpoint
DROP TABLE "relationship_states";
--> statement-breakpoint
DROP TABLE "relationship_entities";
