CREATE TABLE "browser_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"provider_profile_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_session_instances" (
	"provider_session_id" uuid PRIMARY KEY NOT NULL,
	"browser_session_id" uuid NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"status" varchar(20) NOT NULL,
	"browser_cost_microusd" bigint DEFAULT 0 NOT NULL,
	"proxy_cost_microusd" bigint DEFAULT 0 NOT NULL,
	"proxy_used_mb" text DEFAULT '0' NOT NULL,
	"pricing_unit_price" bigint NOT NULL,
	"pricing_unit_size" bigint NOT NULL,
	"gross_credits" bigint DEFAULT 0 NOT NULL,
	"credits_charged" bigint,
	"usage_event_id" uuid,
	"timeout_at" timestamp NOT NULL,
	"started_at" timestamp NOT NULL,
	"stop_requested_at" timestamp,
	"finished_at" timestamp,
	"settled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "browser_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_thread_id" uuid NOT NULL,
	"run_id" uuid,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" varchar(64) NOT NULL,
	"browser_profile_id" uuid NOT NULL,
	"status" varchar(20) NOT NULL,
	"proxy_country_code" varchar(2),
	"timeout_minutes" integer NOT NULL,
	"max_credits" integer NOT NULL,
	"gross_credits" bigint DEFAULT 0 NOT NULL,
	"credits_charged" bigint DEFAULT 0 NOT NULL,
	"suspended_at" timestamp,
	"suspension_reason" varchar(20),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_session_instances" ADD CONSTRAINT "browser_session_instances_browser_session_id_browser_sessions_id_fk" FOREIGN KEY ("browser_session_id") REFERENCES "public"."browser_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_session_instances" ADD CONSTRAINT "browser_session_instances_usage_event_id_usage_event_id_fk" FOREIGN KEY ("usage_event_id") REFERENCES "public"."usage_event"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_browser_profile_id_browser_profiles_id_fk" FOREIGN KEY ("browser_profile_id") REFERENCES "public"."browser_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_browser_profiles_owner" ON "browser_profiles" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_browser_profiles_provider_profile" ON "browser_profiles" USING btree ("provider_profile_id");--> statement-breakpoint
CREATE INDEX "idx_browser_session_instances_session" ON "browser_session_instances" USING btree ("browser_session_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_browser_session_instances_run_status" ON "browser_session_instances" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "idx_browser_session_instances_reconcile" ON "browser_session_instances" USING btree ("status","settled_at","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_browser_session_instances_thread_owned" ON "browser_session_instances" USING btree ("chat_thread_id") WHERE "browser_session_instances"."status" IN ('active', 'stopping');--> statement-breakpoint
CREATE INDEX "idx_browser_sessions_chat_thread_created" ON "browser_sessions" USING btree ("chat_thread_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_browser_sessions_owner_created" ON "browser_sessions" USING btree ("org_id","user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_browser_sessions_reconcile" ON "browser_sessions" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_browser_sessions_thread_owned" ON "browser_sessions" USING btree ("chat_thread_id") WHERE "browser_sessions"."status" IN ('creating', 'active', 'resuming', 'stopping');