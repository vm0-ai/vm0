CREATE TABLE "user_behavior_count" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"behavior_key" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"first_at" timestamp DEFAULT now() NOT NULL,
	"last_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_behavior_count_org_id_user_id_behavior_key_pk" PRIMARY KEY("org_id","user_id","behavior_key")
);
