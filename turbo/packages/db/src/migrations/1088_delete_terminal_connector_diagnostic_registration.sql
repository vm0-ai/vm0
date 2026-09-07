CREATE FUNCTION public.delete_terminal_run_connector_diagnostic_registration() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    DELETE FROM public.agent_run_connector_diagnostic_registrations
    WHERE run_id = NEW.id;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER agent_runs_delete_terminal_connector_diagnostic_registration
AFTER UPDATE OF status ON agent_runs
FOR EACH ROW
WHEN (NEW.status IN ('completed', 'failed', 'timeout', 'cancelled'))
EXECUTE FUNCTION public.delete_terminal_run_connector_diagnostic_registration();
