ALTER TABLE "credit_pricing" ADD COLUMN "cache_read_token_price" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_pricing" ADD COLUMN "cache_creation_token_price" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_usage" ADD COLUMN "cache_read_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_usage" ADD COLUMN "cache_creation_input_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_usage" ADD COLUMN "web_search_requests" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_usage" ADD COLUMN "cost_usd" numeric(12, 8);