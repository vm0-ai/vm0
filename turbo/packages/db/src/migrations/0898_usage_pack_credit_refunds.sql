CREATE TABLE "usage_pack_credit_refunds" (
	"credit_grant_id" uuid PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"stripe_invoice_id" text,
	"stripe_invoice_line_id" text,
	"stripe_payment_intent_id" text,
	"source_amount_cents" integer NOT NULL,
	"status" varchar(20) DEFAULT 'available' NOT NULL,
	"refund_credits" bigint,
	"requested_amount_cents" integer,
	"refunded_amount_cents" integer,
	"stripe_credit_note_id" text,
	"stripe_refund_id" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"failure_reason" text,
	"refunded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chk_usage_pack_credit_refunds_source" CHECK (("usage_pack_credit_refunds"."source_type" = 'invoice' AND "usage_pack_credit_refunds"."stripe_invoice_id" IS NOT NULL AND "usage_pack_credit_refunds"."stripe_payment_intent_id" IS NULL) OR ("usage_pack_credit_refunds"."source_type" = 'payment_intent' AND "usage_pack_credit_refunds"."stripe_invoice_id" IS NULL AND "usage_pack_credit_refunds"."stripe_invoice_line_id" IS NULL AND "usage_pack_credit_refunds"."stripe_payment_intent_id" IS NOT NULL)),
	CONSTRAINT "chk_usage_pack_credit_refunds_status" CHECK ("usage_pack_credit_refunds"."status" IN ('available', 'pending', 'processing', 'succeeded', 'failed')),
	CONSTRAINT "chk_usage_pack_credit_refunds_source_amount" CHECK ("usage_pack_credit_refunds"."source_amount_cents" >= 0),
	CONSTRAINT "chk_usage_pack_credit_refunds_snapshot" CHECK (("usage_pack_credit_refunds"."status" = 'available' AND "usage_pack_credit_refunds"."refund_credits" IS NULL AND "usage_pack_credit_refunds"."requested_amount_cents" IS NULL) OR ("usage_pack_credit_refunds"."status" <> 'available' AND "usage_pack_credit_refunds"."refund_credits" > 0 AND "usage_pack_credit_refunds"."requested_amount_cents" > 0)),
	CONSTRAINT "chk_usage_pack_credit_refunds_refunded_amount" CHECK ("usage_pack_credit_refunds"."refunded_amount_cents" IS NULL OR "usage_pack_credit_refunds"."refunded_amount_cents" >= 0),
	CONSTRAINT "chk_usage_pack_credit_refunds_attempt" CHECK ("usage_pack_credit_refunds"."attempt" > 0)
);
--> statement-breakpoint
ALTER TABLE "org_plan_entitlements" ADD COLUMN "member_invite_usage_pack_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_pack_credit_refunds" ADD CONSTRAINT "usage_pack_credit_refunds_credit_grant_id_usage_pack_credit_grants_id_fk" FOREIGN KEY ("credit_grant_id") REFERENCES "public"."usage_pack_credit_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_usage_pack_credit_refunds_member" ON "usage_pack_credit_refunds" USING btree ("org_id","user_id","status");--> statement-breakpoint
CREATE INDEX "idx_usage_pack_credit_refunds_reconcile" ON "usage_pack_credit_refunds" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_credit_refunds_credit_note" ON "usage_pack_credit_refunds" USING btree ("stripe_credit_note_id") WHERE "usage_pack_credit_refunds"."stripe_credit_note_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_pack_credit_refunds_refund" ON "usage_pack_credit_refunds" USING btree ("stripe_refund_id") WHERE "usage_pack_credit_refunds"."stripe_refund_id" IS NOT NULL;