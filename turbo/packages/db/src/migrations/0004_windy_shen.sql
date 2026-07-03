CREATE TYPE "public"."device_code_status" AS ENUM('pending', 'authenticated', 'expired', 'denied');--> statement-breakpoint
CREATE TABLE "cli_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cli_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "device_codes" (
	"code" varchar(9) PRIMARY KEY NOT NULL,
	"status" "device_code_status" DEFAULT 'pending' NOT NULL,
	"user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
