ALTER TABLE "browser_session_instances" DROP CONSTRAINT "browser_session_instances_usage_event_id_usage_event_id_fk";
--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "billing_run_id";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "browser_cost_microusd";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "proxy_cost_microusd";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "proxy_used_mb";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "pricing_unit_price";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "pricing_unit_size";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "gross_credits";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "credits_charged";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "usage_event_id";--> statement-breakpoint
ALTER TABLE "browser_session_instances" DROP COLUMN "settled_at";--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP COLUMN "max_credits";--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP COLUMN "gross_credits";--> statement-breakpoint
ALTER TABLE "browser_sessions" DROP COLUMN "credits_charged";