import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgPlanEntitlements } from "@vm0/db/schema/org-plan-entitlement";
import { eq, sql } from "drizzle-orm";

import type { Db } from "../external/db";
import { pgBooleanDecoder } from "../../lib/db-structured-result";

type ReadDb = Pick<Db, "select">;

export interface OrgPlanCapabilities {
  readonly status: "active" | "suspended";
  readonly baseConcurrencyLimit: number;
  readonly canBuyConcurrency: boolean;
  readonly canBuyCredits: boolean;
  readonly memberInviteUsagePackRequired: boolean;
  readonly memberInvitationAllowed: boolean;
  readonly autoRechargeAllowed: boolean;
  readonly supportByok: boolean;
  readonly restrictedVm0Models: boolean;
  readonly videoGenerationAllowed: boolean;
  readonly workflowWebhookAutomationAllowed: boolean;
  readonly audioLifetimeLimit: number | null;
  readonly audioDailyRateLimit: number;
  readonly audioDailyDurationSeconds: number;
}

const CAPABILITY_SELECTION = {
  status: orgPlanEntitlements.status,
  baseConcurrencyLimit: orgPlanEntitlements.baseConcurrencyLimit,
  canBuyConcurrency: orgPlanEntitlements.canBuyConcurrency,
  canBuyCredits: orgPlanEntitlements.canBuyCredits,
  memberInviteUsagePackRequired: sql`
    COALESCE(
      (to_jsonb(${orgPlanEntitlements}) ->> 'member_invite_usage_pack_required')::boolean,
      false
    )
  `.mapWith(pgBooleanDecoder),
  memberInvitationAllowed: sql`
      COALESCE(
        (to_jsonb(${orgPlanEntitlements}) ->> 'member_invitation_allowed')::boolean,
        ${orgPlanEntitlements.planKey} IN ('pro', 'team', 'custom')
      )
    `.mapWith(pgBooleanDecoder),
  autoRechargeAllowed: orgPlanEntitlements.autoRechargeAllowed,
  supportByok: orgPlanEntitlements.supportByok,
  restrictedVm0Models: orgPlanEntitlements.restrictedVm0Models,
  videoGenerationAllowed: orgPlanEntitlements.videoGenerationAllowed,
  workflowWebhookAutomationAllowed:
    orgPlanEntitlements.workflowWebhookTriggerAllowed,
  audioLifetimeLimit: orgPlanEntitlements.audioLifetimeLimit,
  audioDailyRateLimit: orgPlanEntitlements.audioDailyRateLimit,
  audioDailyDurationSeconds: orgPlanEntitlements.audioDailyDurationSeconds,
} as const;

export async function memberInviteUsagePackEntitlementSchemaAvailable(
  db: ReadDb,
): Promise<boolean> {
  // A new API can deploy before migration 0898 during the DB/API rollout
  // window. Remove this probe after 0898 is guaranteed across that window.
  const [state] = await db
    .select({
      available: sql`
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute
          WHERE attrelid = to_regclass('org_plan_entitlements')
            AND attname = 'member_invite_usage_pack_required'
            AND NOT attisdropped
        )
      `.mapWith(pgBooleanDecoder),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  if (!state) {
    throw new Error("Member invite usage pack schema probe returned no row");
  }
  return state.available;
}

export async function memberInvitationEntitlementSchemaAvailable(
  db: ReadDb,
): Promise<boolean> {
  // A new API can deploy before migration 0901 during the DB/API rollout
  // window. Remove this probe after 0901 is guaranteed across that window.
  const [state] = await db
    .select({
      available: sql`
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_attribute
          WHERE attrelid = to_regclass('org_plan_entitlements')
            AND attname = 'member_invitation_allowed'
            AND NOT attisdropped
        )
      `.mapWith(pgBooleanDecoder),
    })
    .from(sql`(SELECT 1) AS schema_probe`)
    .limit(1);
  if (!state) {
    throw new Error("Member invitation schema probe returned no row");
  }
  return state.available;
}

function runtimeStatusForEntitlement(
  status: string,
): OrgPlanCapabilities["status"] {
  switch (status) {
    case "active":
    case "trialing":
    case "past_due":
    case "unpaid":
    case "atom_grant":
    case "manual_active": {
      return "active";
    }
    default: {
      return "suspended";
    }
  }
}

export async function loadOrgPlanCapabilities(
  db: ReadDb,
  orgId: string,
  options?: { readonly forUpdate?: boolean },
): Promise<OrgPlanCapabilities | null> {
  const query = db
    .select(CAPABILITY_SELECTION)
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.orgId, orgId))
    .limit(1);
  const [capabilities] = options?.forUpdate
    ? await query.for("update")
    : await query;
  if (!capabilities) {
    const orgQuery = db
      .select({ orgId: orgMetadata.orgId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);
    const [org] = options?.forUpdate
      ? await orgQuery.for("update")
      : await orgQuery;
    if (!org) {
      return null;
    }
    throw new Error(`Missing org plan entitlement for ${orgId}`);
  }
  return {
    ...capabilities,
    status: runtimeStatusForEntitlement(capabilities.status),
  };
}
