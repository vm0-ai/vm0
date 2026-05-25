CREATE TABLE "org_members" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"timezone" text,
	"notify_email" boolean DEFAULT false NOT NULL,
	"notify_slack" boolean DEFAULT true NOT NULL,
	"pinned_agent_ids" jsonb DEFAULT '[]'::jsonb,
	"send_mode" text DEFAULT 'enter' NOT NULL,
	"onboarding_done" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
INSERT INTO org_members (org_id, user_id, timezone, notify_email, notify_slack, pinned_agent_ids, send_mode, onboarding_done, created_at, updated_at)
SELECT org_id, user_id, timezone, notify_email, notify_slack, pinned_agent_ids, send_mode, onboarding_done, cached_at, cached_at
FROM org_members_cache
WHERE timezone IS NOT NULL OR notify_email != false OR notify_slack != true OR pinned_agent_ids != '[]'::jsonb OR send_mode != 'enter' OR onboarding_done != false
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "org_members_cache" DROP COLUMN IF EXISTS "timezone";--> statement-breakpoint
ALTER TABLE "org_members_cache" DROP COLUMN IF EXISTS "notify_email";--> statement-breakpoint
ALTER TABLE "org_members_cache" DROP COLUMN IF EXISTS "notify_slack";--> statement-breakpoint
ALTER TABLE "org_members_cache" DROP COLUMN IF EXISTS "pinned_agent_ids";--> statement-breakpoint
ALTER TABLE "org_members_cache" DROP COLUMN IF EXISTS "send_mode";--> statement-breakpoint
ALTER TABLE "org_members_cache" DROP COLUMN IF EXISTS "onboarding_done";
