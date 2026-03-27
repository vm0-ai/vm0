-- Fix unique index on credit_expires_record to exclude NULL stripe_invoice_id values.
-- PostgreSQL treats NULLs as distinct in unique indexes, which allowed duplicate
-- bootstrap rows (where stripe_invoice_id IS NULL) on re-run. The index must only
-- enforce uniqueness when stripe_invoice_id is present.
DROP INDEX IF EXISTS "uq_credit_expires_invoice";
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_credit_expires_invoice" ON "credit_expires_record" USING btree ("org_id","stripe_invoice_id") WHERE stripe_invoice_id IS NOT NULL;
