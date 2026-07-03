ALTER TABLE "credit_usage" RENAME COLUMN "num_turns" TO "num_events";--> statement-breakpoint
ALTER TABLE "credit_pricing" DROP COLUMN "turn_price";
