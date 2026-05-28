DELETE FROM "connectors" WHERE "type" IN ('local-agent', 'local-browser');--> statement-breakpoint
DROP TABLE IF EXISTS "remote_agent_device_codes" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "remote_agent_hosts" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "remote_agent_jobs" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "local_browser_command_audit_events" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "local_browser_commands" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "local_browser_device_codes" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "local_browser_hosts" CASCADE;
