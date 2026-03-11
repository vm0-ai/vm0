CREATE TABLE "org_members_cache" (
	"clerk_org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"timezone" text,
	"notify_email" boolean DEFAULT false NOT NULL,
	"notify_slack" boolean DEFAULT true NOT NULL,
	"cached_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_cache_clerk_org_id_user_id_pk" PRIMARY KEY("clerk_org_id","user_id")
);
