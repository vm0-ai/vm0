CREATE TABLE "org_cache" (
	"clerk_org_id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"tier" text DEFAULT 'free' NOT NULL,
	"cached_at" timestamp DEFAULT now() NOT NULL
);
