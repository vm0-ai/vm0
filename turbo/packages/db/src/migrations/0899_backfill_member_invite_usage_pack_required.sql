UPDATE "org_plan_entitlements" AS "entitlement"
SET "member_invite_usage_pack_required" = true
WHERE "entitlement"."plan_key" IN ('pro', 'team')
  AND EXISTS (
    SELECT 1
    FROM "usage_pack_subscriptions" AS "subscription"
    WHERE "subscription"."org_id" = "entitlement"."org_id"
      AND "subscription"."stripe_subscription_id" = "entitlement"."stripe_subscription_id"
      AND "subscription"."stripe_subscription_id" IS NOT NULL
      AND "subscription"."subscription_status" NOT IN (
        'canceled',
        'incomplete_expired',
        'invalid'
      )
  );
