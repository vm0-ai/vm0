ALTER TABLE "org_plan_entitlements" ADD COLUMN "member_invitation_allowed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
UPDATE "org_plan_entitlements"
SET "member_invitation_allowed" = true
WHERE "plan_key" IN ('pro', 'team', 'custom');
--> statement-breakpoint
CREATE FUNCTION "sync_legacy_org_plan_entitlement_member_invitation_allowed"() RETURNS trigger AS $$
BEGIN
	IF NEW."source" IN (
		'stripe_subscription',
		'stripe_atom_grant',
		'org_metadata_bootstrap',
		'org_metadata_migration'
	) THEN
		NEW."member_invitation_allowed" := NEW."plan_key" IN ('pro', 'team', 'custom');
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "sync_legacy_org_plan_entitlement_member_invitation_allowed"
BEFORE INSERT OR UPDATE OF "plan_key" ON "org_plan_entitlements"
FOR EACH ROW EXECUTE FUNCTION "sync_legacy_org_plan_entitlement_member_invitation_allowed"();
