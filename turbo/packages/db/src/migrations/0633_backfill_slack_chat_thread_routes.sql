DO $$
DECLARE
	valid_slot_count bigint;
	skipped_slot_count bigint;
	inserted_route_count bigint;
BEGIN
	SELECT
		COUNT(*) FILTER (WHERE agent_session."id" IS NOT NULL),
		COUNT(*) FILTER (WHERE agent_session."id" IS NULL)
	INTO valid_slot_count, skipped_slot_count
	FROM "slack_org_thread_sessions" AS thread_session
	LEFT JOIN "agent_sessions" AS agent_session
		ON agent_session."id" = thread_session."agent_session_id";

	INSERT INTO "slack_chat_thread_routes" (
		"connection_id",
		"channel_id",
		"thread_ts",
		"user_id",
		"backend"
	)
	SELECT
		thread_session."connection_id",
		thread_session."slack_channel_id",
		thread_session."slack_thread_ts",
		agent_session."user_id",
		'legacy'
	FROM "slack_org_thread_sessions" AS thread_session
	INNER JOIN "agent_sessions" AS agent_session
		ON agent_session."id" = thread_session."agent_session_id";

	GET DIAGNOSTICS inserted_route_count = ROW_COUNT;

	IF inserted_route_count <> valid_slot_count THEN
		RAISE EXCEPTION 'slack chat thread route backfill expected % valid routes but inserted %',
			valid_slot_count,
			inserted_route_count;
	END IF;

	RAISE NOTICE 'slack chat thread route backfill inserted % legacy routes and skipped % slots with no resolvable owner',
		inserted_route_count,
		skipped_slot_count;
END $$;
