CREATE TABLE "org" (
	"org_id" text PRIMARY KEY NOT NULL,
	"credits" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
