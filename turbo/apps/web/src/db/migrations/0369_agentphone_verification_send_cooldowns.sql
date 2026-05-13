CREATE TABLE "agentphone_verification_send_cooldowns" (
	"scope" varchar(32) NOT NULL,
	"scope_key" text NOT NULL,
	"last_sent_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agentphone_verification_send_cooldowns_pkey" PRIMARY KEY("scope","scope_key")
);
