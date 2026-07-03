CREATE TABLE "user_cache" (
	"user_id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"org_list_cached_at" timestamp,
	"cached_at" timestamp DEFAULT now() NOT NULL
);
