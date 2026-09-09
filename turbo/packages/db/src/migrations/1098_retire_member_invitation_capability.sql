-- Outgoing API statements still read/write this column. It is now a derived
-- compatibility value, including for manual entitlements, not an override.
-- Drop the column and trigger after the serving/rollback gate in #32575.
CREATE OR REPLACE FUNCTION public.sync_legacy_org_plan_entitlement_member_invitation_allowed()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."member_invitation_allowed" := NEW."status" IN (
    'active', 'trialing', 'past_due', 'unpaid', 'atom_grant', 'manual_active'
  );
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER sync_legacy_org_plan_entitlement_member_invitation_allowed ON "org_plan_entitlements";
--> statement-breakpoint
CREATE TRIGGER sync_legacy_org_plan_entitlement_member_invitation_allowed
BEFORE INSERT OR UPDATE OF status, member_invitation_allowed ON "org_plan_entitlements"
FOR EACH ROW EXECUTE FUNCTION public.sync_legacy_org_plan_entitlement_member_invitation_allowed();
--> statement-breakpoint
UPDATE "org_plan_entitlements"
SET "member_invitation_allowed" = "status" IN (
  'active', 'trialing', 'past_due', 'unpaid', 'atom_grant', 'manual_active'
), "updated_at" = now()
WHERE "member_invitation_allowed" IS DISTINCT FROM ("status" IN (
  'active', 'trialing', 'past_due', 'unpaid', 'atom_grant', 'manual_active'
));
