ALTER TABLE "org_plan_entitlements" ADD COLUMN "show_usage_pack" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "org_plan_entitlements"
SET "show_usage_pack" = true
WHERE "plan_key" IN ('pro', 'team')
  AND "member_invite_usage_pack_required" = true;
--> statement-breakpoint
-- Keep outgoing and rollback API writers consistent until every supported API
-- version explicitly writes show_usage_pack. Cleanup: vm0-ai/vm0#32575.
CREATE FUNCTION "sync_legacy_org_plan_entitlement_show_usage_pack"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."source" IN (
    'stripe_subscription',
    'stripe_atom_grant',
    'org_metadata_bootstrap',
    'org_metadata_migration'
  ) THEN
    NEW."show_usage_pack" := NEW."plan_key" IN ('pro', 'team')
      AND NEW."member_invite_usage_pack_required";
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "trg_org_plan_entitlement_show_usage_pack"
BEFORE INSERT OR UPDATE OF "plan_key", "member_invite_usage_pack_required"
ON "org_plan_entitlements"
FOR EACH ROW EXECUTE FUNCTION "sync_legacy_org_plan_entitlement_show_usage_pack"();
