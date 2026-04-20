CREATE TABLE "redemption_code_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"attempted_at" timestamp DEFAULT now() NOT NULL,
	"success" boolean NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_redemption_code_attempts_user_time" ON "redemption_code_attempts" USING btree ("user_id","attempted_at");