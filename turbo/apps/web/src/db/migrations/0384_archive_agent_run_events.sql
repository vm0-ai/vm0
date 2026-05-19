ALTER TABLE "agent_run_events" RENAME TO "_archive_2026_06_14_agent_run_events";--> statement-breakpoint
ALTER TABLE "_archive_2026_06_14_agent_run_events" RENAME CONSTRAINT "agent_run_events_pkey" TO "_archive_2026_06_14_agent_run_events_pkey";--> statement-breakpoint
ALTER TABLE "_archive_2026_06_14_agent_run_events" DROP CONSTRAINT "agent_run_events_run_id_agent_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "_archive_2026_06_14_agent_run_events" ADD CONSTRAINT "_archive_2026_06_14_agent_run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;
