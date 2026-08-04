SELECT count(*) AS total_rows, min(created_at), max(created_at)
FROM chat_event_input_params;--> statement-breakpoint

-- if non-empty, these are the events a drop would strand
SELECT coalesce(e.trigger_source, '(null)') AS trigger_source, count(*) AS pending_with_params
FROM chat_event_input_params p
JOIN chat_events e ON e.id = p.event_id
WHERE e.run_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM chat_events r WHERE r.revokes_event_id = e.id)
GROUP BY 1;--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "chat_event_input_params") THEN
    RAISE EXCEPTION 'chat_event_input_params must be empty before it is dropped';
  END IF;
END;
$$;--> statement-breakpoint

ALTER TABLE "chat_event_input_params" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "chat_event_input_params" CASCADE;
