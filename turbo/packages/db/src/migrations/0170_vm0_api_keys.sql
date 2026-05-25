CREATE TABLE "vm0_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor" varchar(50) NOT NULL,
	"model" varchar(255) NOT NULL,
	"api_key" text NOT NULL,
	"label" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_vm0_api_keys_vendor" ON "vm0_api_keys" USING btree ("vendor");
