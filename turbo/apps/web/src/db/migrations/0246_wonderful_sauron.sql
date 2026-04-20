CREATE TABLE "user_feature_switches" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"switches" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_feature_switches_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
