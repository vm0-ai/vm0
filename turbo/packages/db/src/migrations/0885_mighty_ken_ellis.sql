CREATE TABLE "model_provider_account_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_provider_account_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"encrypted_value" text NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_provider_id" uuid NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" varchar(50) NOT NULL,
	"auth_method" varchar(50),
	"is_active" boolean DEFAULT false NOT NULL,
	"external_account_id" varchar(255),
	"account_email" varchar(320),
	"workspace_name" varchar(255),
	"plan_type" varchar(32),
	"token_expires_at" timestamp,
	"needs_reconnect" boolean DEFAULT false NOT NULL,
	"last_refresh_error_code" varchar(64),
	"subscription_reset_period" varchar(64),
	"subscription_next_reset_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_provider_account_secrets" ADD CONSTRAINT "model_provider_account_secrets_model_provider_account_id_model_provider_accounts_id_fk" FOREIGN KEY ("model_provider_account_id") REFERENCES "public"."model_provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_accounts" ADD CONSTRAINT "model_provider_accounts_model_provider_id_model_providers_id_fk" FOREIGN KEY ("model_provider_id") REFERENCES "public"."model_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_provider_account_secrets_account_name" ON "model_provider_account_secrets" USING btree ("model_provider_account_id","name");--> statement-breakpoint
CREATE INDEX "idx_model_provider_accounts_provider" ON "model_provider_accounts" USING btree ("model_provider_id");--> statement-breakpoint
CREATE INDEX "idx_model_provider_accounts_owner_type" ON "model_provider_accounts" USING btree ("org_id","user_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_provider_accounts_one_active" ON "model_provider_accounts" USING btree ("model_provider_id") WHERE "model_provider_accounts"."is_active" = true;