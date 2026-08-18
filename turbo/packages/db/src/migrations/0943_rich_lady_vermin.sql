CREATE TABLE "weekly_product_update_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"weekly_product_update_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"chat_thread_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weekly_product_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"post_slug" text,
	"post_url" text,
	"subject" text,
	"message" text,
	"broadcast_sent_at" timestamp,
	"delivered_at" timestamp,
	"skip_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_members_metadata" ADD COLUMN "weekly_product_update_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "weekly_product_update_deliveries" ADD CONSTRAINT "weekly_product_update_deliveries_weekly_product_update_id_weekly_product_updates_id_fk" FOREIGN KEY ("weekly_product_update_id") REFERENCES "public"."weekly_product_updates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_product_update_deliveries" ADD CONSTRAINT "weekly_product_update_deliveries_chat_thread_id_chat_threads_id_fk" FOREIGN KEY ("chat_thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_weekly_product_update_deliveries_update_user" ON "weekly_product_update_deliveries" USING btree ("weekly_product_update_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_weekly_product_updates_broadcast" ON "weekly_product_updates" USING btree ("broadcast_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_weekly_product_updates_post_slug" ON "weekly_product_updates" USING btree ("post_slug") WHERE status = 'ready';--> statement-breakpoint
CREATE INDEX "idx_weekly_product_updates_status" ON "weekly_product_updates" USING btree ("status");