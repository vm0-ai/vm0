import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";
import type { OrgPlanEntitlementSourceMetadata } from "@vm0/db/jsonb-contracts/org-plan-entitlement";
import { orgPlanEntitlements } from "@vm0/db/schema/org-plan-entitlement";
import { eq } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

import { nowDate } from "../../lib/time";
import { ORG_PLAN_ENTITLEMENT_TIER_VALUES } from "./org-plan-entitlement-tier-values";
import { memberInviteUsagePackEntitlementSchemaAvailable } from "./org-plan-entitlement-read.service";
import type { Tx } from "../../lib/db-types";

type WriteTx = Tx;

// Drizzle names every column declared by an insert table, even when a value is
// omitted. This runtime-only shape keeps pre-0898 writes from naming the new
// column during the DB/API rollout window. Remove it with the schema probe once
// migration 0898 is guaranteed everywhere and the rollback window closes.
const orgPlanEntitlementsBeforeMemberInviteUsagePack = pgTable(
  "org_plan_entitlements",
  {
    orgId: text("org_id").primaryKey(),
    planKey: text("plan_key").notNull(),
    planRank: integer("plan_rank").notNull(),
    source: varchar("source", { length: 50 }).notNull(),
    status: varchar("status", { length: 30 }).notNull().default("active"),
    baseConcurrencyLimit: integer("base_concurrency_limit")
      .notNull()
      .default(0),
    canBuyConcurrency: boolean("can_buy_concurrency").notNull().default(false),
    canBuyCredits: boolean("can_buy_credits").notNull().default(false),
    autoRechargeAllowed: boolean("auto_recharge_allowed")
      .notNull()
      .default(false),
    supportByok: boolean("support_byok").notNull().default(false),
    restrictedVm0Models: boolean("restricted_vm0_models")
      .notNull()
      .default(true),
    videoGenerationAllowed: boolean("video_generation_allowed")
      .notNull()
      .default(false),
    workflowWebhookTriggerAllowed: boolean("workflow_webhook_trigger_allowed")
      .notNull()
      .default(false),
    audioLifetimeLimit: integer("audio_lifetime_limit"),
    audioDailyRateLimit: integer("audio_daily_rate_limit").notNull().default(0),
    audioDailyDurationSeconds: integer("audio_daily_duration_seconds")
      .notNull()
      .default(0),
    stripeSubscriptionId: text("stripe_subscription_id"),
    stripeProductId: text("stripe_product_id"),
    stripePriceId: text("stripe_price_id"),
    currentPeriodStart: timestamp("current_period_start"),
    currentPeriodEnd: timestamp("current_period_end"),
    cancelAt: timestamp("cancel_at"),
    expiresAt: timestamp("expires_at"),
    metadataVersion: text("metadata_version").notNull().default("1"),
    metadataHash: text("metadata_hash"),
    sourceMetadata: jsonb("source_metadata")
      .$type<OrgPlanEntitlementSourceMetadata>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
);

interface UpsertOrgPlanEntitlementArgs {
  readonly orgId: string;
  readonly tier: OrgTier;
  readonly source:
    | "stripe_subscription"
    | "stripe_atom_grant"
    | "org_metadata_bootstrap"
    | "org_metadata_migration";
  readonly status?: string;
  readonly stripeSubscriptionId?: string | null;
  readonly stripePriceId?: string | null;
  readonly currentPeriodStart?: Date | null;
  readonly currentPeriodEnd?: Date | null;
  readonly cancelAt?: Date | null;
  readonly expiresAt?: Date | null;
  readonly memberInviteUsagePackRequired?: boolean;
  readonly sourceMetadata?: OrgPlanEntitlementSourceMetadata;
}

interface WriteOrgMetadataWithPlanEntitlementsArgs<Row> {
  readonly writeOrgMetadata: (tx: WriteTx) => Promise<Row[]>;
  readonly writePlanEntitlement: (tx: WriteTx, row: Row) => Promise<void>;
}

interface ResolvedStripeSubscriptionSnapshot {
  readonly stripeSubscriptionId: string | null;
  readonly sourceMetadata: OrgPlanEntitlementSourceMetadata;
}

function statusForTier(tier: OrgTier): string {
  return tier === "pro-suspend" ? "suspended" : "active";
}

async function resolveStripeSubscriptionSnapshot(
  tx: WriteTx,
  args: Pick<
    UpsertOrgPlanEntitlementArgs,
    "orgId" | "stripeSubscriptionId" | "sourceMetadata"
  >,
): Promise<ResolvedStripeSubscriptionSnapshot> {
  const sourceMetadata = args.sourceMetadata ?? {};
  const stripeSubscriptionId = args.stripeSubscriptionId ?? null;
  if (!stripeSubscriptionId) {
    return { stripeSubscriptionId: null, sourceMetadata };
  }

  const existingOrgId = await orgPlanEntitlementOrgIdForStripeSubscription(
    tx,
    stripeSubscriptionId,
  );
  if (!existingOrgId || existingOrgId === args.orgId) {
    return { stripeSubscriptionId, sourceMetadata };
  }

  return {
    stripeSubscriptionId: null,
    sourceMetadata: {
      ...sourceMetadata,
      stripeSubscriptionSnapshotSkipped: "duplicate_stripe_subscription_id",
    },
  };
}

export async function writeOrgMetadataWithPlanEntitlements<Row>(
  tx: WriteTx,
  args: WriteOrgMetadataWithPlanEntitlementsArgs<Row>,
): Promise<Row[]> {
  const rows = await args.writeOrgMetadata(tx);
  for (const row of rows) {
    await args.writePlanEntitlement(tx, row);
  }
  return rows;
}

export async function upsertOrgPlanEntitlement(
  tx: WriteTx,
  args: UpsertOrgPlanEntitlementArgs,
): Promise<void> {
  const limits = ORG_PLAN_ENTITLEMENT_TIER_VALUES[args.tier];
  const updatedAt = nowDate();
  const stripeSubscriptionSnapshot = await resolveStripeSubscriptionSnapshot(
    tx,
    args,
  );
  const memberInviteUsagePackRequiredAvailable =
    await memberInviteUsagePackEntitlementSchemaAvailable(tx);
  const memberInviteUsagePackRequired =
    args.memberInviteUsagePackRequired ?? false;
  const values = {
    orgId: args.orgId,
    planKey: args.tier,
    planRank: limits.planRank,
    source: args.source,
    status: args.status ?? statusForTier(args.tier),
    baseConcurrencyLimit: limits.baseConcurrencyLimit,
    canBuyConcurrency: limits.canBuyConcurrency,
    canBuyCredits: limits.canBuyCredits,
    ...(memberInviteUsagePackRequiredAvailable
      ? { memberInviteUsagePackRequired }
      : {}),
    autoRechargeAllowed: limits.autoRechargeAllowed,
    supportByok: limits.supportByok,
    restrictedVm0Models: limits.restrictedVm0Models,
    videoGenerationAllowed: limits.videoGenerationAllowed,
    workflowWebhookTriggerAllowed: limits.workflowWebhookAutomationAllowed,
    audioLifetimeLimit: limits.audioLifetimeLimit,
    audioDailyRateLimit: limits.audioDailyRateLimit,
    audioDailyDurationSeconds: limits.audioDailyDurationSeconds,
    stripeSubscriptionId: stripeSubscriptionSnapshot.stripeSubscriptionId,
    stripePriceId: args.stripePriceId ?? null,
    currentPeriodStart: args.currentPeriodStart ?? null,
    currentPeriodEnd: args.currentPeriodEnd ?? null,
    cancelAt: args.cancelAt ?? null,
    expiresAt: args.expiresAt ?? null,
    sourceMetadata: stripeSubscriptionSnapshot.sourceMetadata,
    updatedAt,
  };
  const insertTable = memberInviteUsagePackRequiredAvailable
    ? orgPlanEntitlements
    : orgPlanEntitlementsBeforeMemberInviteUsagePack;

  await tx
    .insert(insertTable)
    .values(values)
    .onConflictDoUpdate({
      target: insertTable.orgId,
      set: {
        planKey: values.planKey,
        planRank: values.planRank,
        source: values.source,
        status: values.status,
        baseConcurrencyLimit: values.baseConcurrencyLimit,
        canBuyConcurrency: values.canBuyConcurrency,
        canBuyCredits: values.canBuyCredits,
        ...(memberInviteUsagePackRequiredAvailable
          ? { memberInviteUsagePackRequired }
          : {}),
        autoRechargeAllowed: values.autoRechargeAllowed,
        supportByok: values.supportByok,
        restrictedVm0Models: values.restrictedVm0Models,
        videoGenerationAllowed: values.videoGenerationAllowed,
        workflowWebhookTriggerAllowed: values.workflowWebhookTriggerAllowed,
        audioLifetimeLimit: values.audioLifetimeLimit,
        audioDailyRateLimit: values.audioDailyRateLimit,
        audioDailyDurationSeconds: values.audioDailyDurationSeconds,
        stripeSubscriptionId: values.stripeSubscriptionId,
        stripeProductId: null,
        stripePriceId: values.stripePriceId,
        currentPeriodStart: values.currentPeriodStart,
        currentPeriodEnd: values.currentPeriodEnd,
        cancelAt: values.cancelAt,
        expiresAt: values.expiresAt,
        metadataHash: null,
        sourceMetadata: values.sourceMetadata,
        updatedAt,
      },
    });
}

export async function orgPlanEntitlementOrgIdForStripeSubscription(
  tx: WriteTx,
  stripeSubscriptionId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ orgId: orgPlanEntitlements.orgId })
    .from(orgPlanEntitlements)
    .where(eq(orgPlanEntitlements.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  return row?.orgId ?? null;
}
