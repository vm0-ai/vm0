CREATE TABLE "usage_pricing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(30) NOT NULL,
	"provider" varchar(100) NOT NULL,
	"category" varchar(100) NOT NULL,
	"unit_price" bigint NOT NULL,
	"unit_size" bigint NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pricing_kind_provider_category" ON "usage_pricing" USING btree ("kind","provider","category");