CREATE TABLE "e2e_telegram_mock_call_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"method" varchar(64) NOT NULL,
	"bot_token" varchar(255),
	"chat_id" varchar(255),
	"body" text NOT NULL,
	"body_json" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_e2e_telegram_mock_call_log_created_at" ON "e2e_telegram_mock_call_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_e2e_telegram_mock_call_log_method" ON "e2e_telegram_mock_call_log" USING btree ("method");--> statement-breakpoint
CREATE INDEX "idx_e2e_telegram_mock_call_log_chat_id" ON "e2e_telegram_mock_call_log" USING btree ("chat_id");