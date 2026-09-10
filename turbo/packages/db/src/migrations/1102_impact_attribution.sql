ALTER TABLE "org_metadata" ADD COLUMN "impact_click_id" text;--> statement-breakpoint
ALTER TABLE "org_metadata" ADD COLUMN "impact_click_at" timestamp;--> statement-breakpoint
ALTER TABLE "usage_pack_invitation_purchases" ADD COLUMN "impact_click_id" text;--> statement-breakpoint
ALTER TABLE "usage_pack_invitation_purchases" ADD COLUMN "impact_click_at" timestamp;