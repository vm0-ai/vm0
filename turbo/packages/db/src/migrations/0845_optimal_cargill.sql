CREATE TABLE "usage_pack_credit_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"grant_type" varchar(20) NOT NULL,
	"idempotency_key" text NOT NULL,
	"original_amount" bigint NOT NULL,
	"remaining_amount" bigint NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_usage_pack_credit_grants_type" CHECK ("usage_pack_credit_grants"."grant_type" IN ('purchased', 'bonus')),
	CONSTRAINT "chk_usage_pack_credit_grants_original_amount" CHECK ("usage_pack_credit_grants"."original_amount" > 0),
	CONSTRAINT "chk_usage_pack_credit_grants_remaining_amount" CHECK ("usage_pack_credit_grants"."remaining_amount" >= 0 AND "usage_pack_credit_grants"."remaining_amount" <= "usage_pack_credit_grants"."original_amount")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_credit_grants_idempotency" ON "usage_pack_credit_grants" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_usage_pack_credit_grants_member_spendable" ON "usage_pack_credit_grants" USING btree ("org_id","user_id","grant_type","expires_at","id") WHERE "usage_pack_credit_grants"."remaining_amount" > 0;