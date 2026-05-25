CREATE TABLE "redemption_code_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"attempted_at" timestamp DEFAULT now() NOT NULL,
	"success" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "redemption_codes" (
	"code" varchar(32) PRIMARY KEY NOT NULL,
	"credits_per_code" bigint NOT NULL,
	"created_by_org_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"redeemed_by_org_id" text,
	"redeemed_by_user_id" text,
	"redeemed_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "idx_redemption_code_attempts_user_time" ON "redemption_code_attempts" USING btree ("user_id","attempted_at");--> statement-breakpoint
CREATE INDEX "idx_redemption_codes_created_by" ON "redemption_codes" USING btree ("created_by_org_id","created_at");