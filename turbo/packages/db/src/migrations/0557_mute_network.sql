CREATE TABLE "org_usage_allowance_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"source" varchar(50) DEFAULT 'manual' NOT NULL,
	"status" varchar(30) DEFAULT 'active' NOT NULL,
	"short_window_seconds" integer NOT NULL,
	"short_window_units" bigint NOT NULL,
	"weekly_window_seconds" integer DEFAULT 604800 NOT NULL,
	"weekly_window_units" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_org_usage_allowance_short_window_seconds" CHECK ("org_usage_allowance_entitlements"."short_window_seconds" > 0),
	CONSTRAINT "chk_org_usage_allowance_short_window_units" CHECK ("org_usage_allowance_entitlements"."short_window_units" > 0),
	CONSTRAINT "chk_org_usage_allowance_weekly_window_seconds" CHECK ("org_usage_allowance_entitlements"."weekly_window_seconds" > 0),
	CONSTRAINT "chk_org_usage_allowance_weekly_window_units" CHECK ("org_usage_allowance_entitlements"."weekly_window_units" > 0)
);
--> statement-breakpoint
CREATE TABLE "org_usage_allowance_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"entitlement_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"starts_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL,
	"unit_limit" bigint NOT NULL,
	"consumed_units" bigint DEFAULT 0 NOT NULL,
	"created_by_run_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_org_usage_allowance_windows_kind" CHECK ("org_usage_allowance_windows"."kind" IN ('short', 'weekly')),
	CONSTRAINT "chk_org_usage_allowance_windows_limit" CHECK ("org_usage_allowance_windows"."unit_limit" > 0),
	CONSTRAINT "chk_org_usage_allowance_windows_consumed" CHECK ("org_usage_allowance_windows"."consumed_units" >= 0),
	CONSTRAINT "chk_org_usage_allowance_windows_time" CHECK ("org_usage_allowance_windows"."expires_at" > "org_usage_allowance_windows"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "usage_allowance_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usage_event_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"run_id" uuid,
	"short_window_id" uuid NOT NULL,
	"weekly_window_id" uuid NOT NULL,
	"units_applied" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_usage_allowance_allocations_units" CHECK ("usage_allowance_allocations"."units_applied" > 0)
);
--> statement-breakpoint
ALTER TABLE "org_usage_allowance_windows" ADD CONSTRAINT "org_usage_allowance_windows_entitlement_id_org_usage_allowance_entitlements_id_fk" FOREIGN KEY ("entitlement_id") REFERENCES "public"."org_usage_allowance_entitlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_usage_allowance_windows" ADD CONSTRAINT "org_usage_allowance_windows_created_by_run_id_agent_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_allowance_allocations" ADD CONSTRAINT "usage_allowance_allocations_usage_event_id_usage_event_id_fk" FOREIGN KEY ("usage_event_id") REFERENCES "public"."usage_event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_allowance_allocations" ADD CONSTRAINT "usage_allowance_allocations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_allowance_allocations" ADD CONSTRAINT "usage_allowance_allocations_short_window_id_org_usage_allowance_windows_id_fk" FOREIGN KEY ("short_window_id") REFERENCES "public"."org_usage_allowance_windows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_allowance_allocations" ADD CONSTRAINT "usage_allowance_allocations_weekly_window_id_org_usage_allowance_windows_id_fk" FOREIGN KEY ("weekly_window_id") REFERENCES "public"."org_usage_allowance_windows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_org_usage_allowance_entitlements_org" ON "org_usage_allowance_entitlements" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_org_usage_allowance_entitlements_status" ON "org_usage_allowance_entitlements" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_org_usage_allowance_windows_org_kind_starts" ON "org_usage_allowance_windows" USING btree ("org_id","kind","starts_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_org_usage_allowance_windows_org_kind_expires" ON "org_usage_allowance_windows" USING btree ("org_id","kind","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_allowance_allocations_usage_event" ON "usage_allowance_allocations" USING btree ("usage_event_id");--> statement-breakpoint
CREATE INDEX "idx_usage_allowance_allocations_org" ON "usage_allowance_allocations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "idx_usage_allowance_allocations_run" ON "usage_allowance_allocations" USING btree ("run_id");