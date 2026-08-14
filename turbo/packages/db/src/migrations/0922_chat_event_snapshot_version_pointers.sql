-- DB/API expand phase: the previous API replaces a Snapshot by inserting
-- another row with the same (thread, version). Keep that statement legal for
-- the observed 102-minute rollout/rollback window. #27174 will deduplicate the
-- rows and make this index unique after the previous API has drained.
CREATE INDEX "chat_event_snapshots_thread_version_idx" ON "chat_event_snapshots" USING btree ("chat_thread_id", "archive_schema_version");
