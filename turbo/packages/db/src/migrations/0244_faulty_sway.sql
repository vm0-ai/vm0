CREATE TABLE "slack_event_dedup" (
	"event_id" varchar(50) PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
