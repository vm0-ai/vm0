CREATE TABLE "chat_thread_connector_selections" (
	"chat_thread_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"connector_slug" varchar(64),
	"custom_connector_id" uuid,
	CONSTRAINT "chat_thread_connector_selections_thread_connector_pk" PRIMARY KEY("chat_thread_id","connector_id"),
	CONSTRAINT "chk_chat_thread_connector_selections_target" CHECK (num_nonnulls("chat_thread_connector_selections"."connector_slug", "chat_thread_connector_selections"."custom_connector_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "display_name" varchar(255);--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "is_default" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "idx_connectors_id_slug" UNIQUE("id","connector_slug");--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "idx_connectors_id_custom_connector" UNIQUE("id","custom_connector_id");--> statement-breakpoint
ALTER TABLE "feishu_org_connections" ADD COLUMN "connector_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_thread_connector_selections" ADD CONSTRAINT "fk_chat_thread_connector_selections_thread" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_connector_selections" ADD CONSTRAINT "fk_chat_thread_connector_selections_connector_slug" FOREIGN KEY ("connector_id","connector_slug") REFERENCES "public"."connectors"("id","connector_slug") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_thread_connector_selections" ADD CONSTRAINT "fk_chat_thread_connector_selections_custom_connector" FOREIGN KEY ("connector_id","custom_connector_id") REFERENCES "public"."connectors"("id","custom_connector_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_thread_connector_selections_thread_slug" ON "chat_thread_connector_selections" USING btree ("chat_thread_id","connector_slug") WHERE "chat_thread_connector_selections"."connector_slug" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_thread_connector_selections_thread_custom_connector" ON "chat_thread_connector_selections" USING btree ("chat_thread_id","custom_connector_id") WHERE "chat_thread_connector_selections"."custom_connector_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_chat_thread_connector_selections_connector" ON "chat_thread_connector_selections" USING btree ("connector_id");--> statement-breakpoint
CREATE INDEX "idx_chat_thread_connector_selections_custom_connector" ON "chat_thread_connector_selections" USING btree ("custom_connector_id");--> statement-breakpoint
ALTER TABLE "feishu_org_connections" ADD CONSTRAINT "feishu_org_connections_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connectors_org_user_custom_connector_default" ON "connectors" USING btree ("org_id","user_id","custom_connector_id") WHERE "connectors"."custom_connector_id" IS NOT NULL AND "connectors"."is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_connectors_org_user_slug_default" ON "connectors" USING btree ("org_id","user_id","connector_slug") WHERE "connectors"."connector_slug" IS NOT NULL AND "connectors"."is_default" = true;--> statement-breakpoint
WITH "candidate_pairs" AS (
	SELECT
		"feishu_connection"."id" AS "feishu_connection_id",
		"connector"."id" AS "connector_id",
		count(*) OVER (
			PARTITION BY "feishu_connection"."id"
		) AS "connection_match_count",
		count(*) OVER (
			PARTITION BY "connector"."id"
		) AS "connector_match_count"
	FROM "feishu_org_connections" AS "feishu_connection"
	INNER JOIN "feishu_org_installations" AS "installation"
		ON "installation"."id" = "feishu_connection"."installation_id"
	INNER JOIN "connectors" AS "connector"
		ON "connector"."custom_connector_id" = "installation"."custom_connector_id"
		AND "connector"."org_id" = "installation"."org_id"
		AND "connector"."user_id" = "feishu_connection"."user_id"
)
UPDATE "feishu_org_connections" AS "feishu_connection"
SET "connector_id" = "candidate"."connector_id"
FROM "candidate_pairs" AS "candidate"
WHERE "feishu_connection"."id" = "candidate"."feishu_connection_id"
	AND "candidate"."connection_match_count" = 1
	AND "candidate"."connector_match_count" = 1;--> statement-breakpoint
DO $$
DECLARE
	"unmatched_count" bigint;
	"ambiguous_count" bigint;
BEGIN
	WITH "candidate_pairs" AS (
		SELECT
			"feishu_connection"."id" AS "feishu_connection_id",
			"connector"."id" AS "connector_id",
			count(*) OVER (
				PARTITION BY "connector"."id"
			) AS "connector_match_count"
		FROM "feishu_org_connections" AS "feishu_connection"
		INNER JOIN "feishu_org_installations" AS "installation"
			ON "installation"."id" = "feishu_connection"."installation_id"
		INNER JOIN "connectors" AS "connector"
			ON "connector"."custom_connector_id" = "installation"."custom_connector_id"
			AND "connector"."org_id" = "installation"."org_id"
			AND "connector"."user_id" = "feishu_connection"."user_id"
	),
	"connection_matches" AS (
		SELECT
			"feishu_connection"."id",
			count("candidate"."connector_id") AS "match_count",
			coalesce(
				bool_or("candidate"."connector_match_count" > 1),
				false
			) AS "shares_connector"
		FROM "feishu_org_connections" AS "feishu_connection"
		LEFT JOIN "candidate_pairs" AS "candidate"
			ON "candidate"."feishu_connection_id" = "feishu_connection"."id"
		GROUP BY "feishu_connection"."id"
	)
	SELECT
		count(*) FILTER (WHERE "match_count" = 0),
		count(*) FILTER (
			WHERE "match_count" > 1 OR "shares_connector"
		)
	INTO "unmatched_count", "ambiguous_count"
	FROM "connection_matches";

	RAISE NOTICE
		'Feishu connector account backfill skipped % unmatched and % ambiguous rows',
		"unmatched_count",
		"ambiguous_count";
END;
$$;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_org_connections_connector" ON "feishu_org_connections" USING btree ("connector_id") WHERE "feishu_org_connections"."connector_id" IS NOT NULL;
