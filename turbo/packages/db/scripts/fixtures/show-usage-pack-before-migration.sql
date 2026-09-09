-- org_plan_entitlements from 1089_snapshot.json at
-- 31c98f1feb32cd19c975467d6943c9532813fc52, for historical 1090 backfill coverage.
CREATE TABLE "org_plan_entitlements" (
  "org_id" text PRIMARY KEY NOT NULL,
  "plan_key" text NOT NULL,
  "plan_rank" integer NOT NULL,
  "source" varchar(50) NOT NULL,
  "status" varchar(30) DEFAULT 'active' NOT NULL,
  "base_concurrency_limit" integer DEFAULT 0 NOT NULL,
  "can_buy_concurrency" boolean DEFAULT false NOT NULL,
  "can_buy_credits" boolean DEFAULT false NOT NULL,
  "member_invite_usage_pack_required" boolean DEFAULT false NOT NULL,
  "member_invitation_allowed" boolean DEFAULT false NOT NULL,
  "auto_recharge_allowed" boolean DEFAULT false NOT NULL,
  "support_byok" boolean DEFAULT false NOT NULL,
  "video_generation_allowed" boolean DEFAULT false NOT NULL,
  "workflow_webhook_trigger_allowed" boolean DEFAULT false NOT NULL,
  "audio_lifetime_limit" integer,
  "audio_daily_rate_limit" integer DEFAULT 0 NOT NULL,
  "audio_daily_duration_seconds" integer DEFAULT 0 NOT NULL,
  "stripe_subscription_id" text,
  "stripe_product_id" text,
  "stripe_price_id" text,
  "current_period_start" timestamp,
  "current_period_end" timestamp,
  "cancel_at" timestamp,
  "expires_at" timestamp,
  "metadata_version" text DEFAULT '1' NOT NULL,
  "metadata_hash" text,
  "source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "restricted_built_in_models" boolean NOT NULL,
  CONSTRAINT "chk_org_plan_entitlements_plan_rank" CHECK ("plan_rank" >= 0),
  CONSTRAINT "chk_org_plan_entitlements_base_concurrency" CHECK ("base_concurrency_limit" >= 0),
  CONSTRAINT "chk_org_plan_entitlements_audio_lifetime" CHECK ("audio_lifetime_limit" IS NULL OR "audio_lifetime_limit" >= 0),
  CONSTRAINT "chk_org_plan_entitlements_audio_daily_rate" CHECK ("audio_daily_rate_limit" >= 0),
  CONSTRAINT "chk_org_plan_entitlements_audio_daily_duration" CHECK ("audio_daily_duration_seconds" >= 0),
  CONSTRAINT "chk_org_plan_entitlements_period" CHECK ("current_period_start" IS NULL OR "current_period_end" IS NULL OR "current_period_end" > "current_period_start")
);
CREATE UNIQUE INDEX "uq_org_plan_entitlements_stripe_subscription" ON "org_plan_entitlements" USING btree ("stripe_subscription_id");
CREATE INDEX "idx_org_plan_entitlements_status" ON "org_plan_entitlements" USING btree ("status");
CREATE INDEX "idx_org_plan_entitlements_source" ON "org_plan_entitlements" USING btree ("source");
CREATE INDEX "idx_org_plan_entitlements_expires" ON "org_plan_entitlements" USING btree ("expires_at");
