-- Contract phase for #21408. Release 1.275.0 promoted the canonical table
-- names to production; both the current API and its rollback target now use
-- those names, so the one-release compatibility views are no longer needed.
DROP VIEW "zero_workflow_triggers";--> statement-breakpoint
DROP VIEW "zero_workflow_webhook_triggers";--> statement-breakpoint
DROP VIEW "workflow_user_trigger_threads";--> statement-breakpoint
DROP VIEW "zero_workflow_trigger_memory_embeddings";
