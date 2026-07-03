CREATE TABLE "pending_outbound_calls" (
	"call_id" varchar(255) PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"session_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
