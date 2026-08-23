CREATE TABLE "pi_resource_snapshots" (
	"digest" varchar(64) PRIMARY KEY NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
