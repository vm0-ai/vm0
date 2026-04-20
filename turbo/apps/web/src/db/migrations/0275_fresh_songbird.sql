CREATE TABLE "e2e_slack_mock_call_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"method" varchar(64) NOT NULL,
	"team_id" varchar(255),
	"channel_id" varchar(255),
	"body" text NOT NULL,
	"body_json" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_e2e_slack_mock_call_log_created_at" ON "e2e_slack_mock_call_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_e2e_slack_mock_call_log_method" ON "e2e_slack_mock_call_log" USING btree ("method");