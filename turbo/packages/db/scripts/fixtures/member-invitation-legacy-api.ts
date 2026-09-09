import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

// Frozen canonical projection and upsert shape from API commit
// b61881b72ea75ef42e5bda960c54c2d63173ec6b. Importing the current schema would
// silently turn this into a new-writer test. Remove with compatibility #32575.
export const legacyOrgPlanEntitlements = pgTable("org_plan_entitlements", {
  orgId: text("org_id").primaryKey(),
  planKey: text("plan_key").notNull(),
  planRank: integer("plan_rank").notNull(),
  source: varchar("source", { length: 50 }).notNull(),
  status: varchar("status", { length: 30 }).notNull().default("active"),
  baseConcurrencyLimit: integer("base_concurrency_limit").notNull().default(0),
  canBuyConcurrency: boolean("can_buy_concurrency").notNull().default(false),
  canBuyCredits: boolean("can_buy_credits").notNull().default(false),
  memberInviteUsagePackRequired: boolean("member_invite_usage_pack_required")
    .notNull()
    .default(false),
  showUsagePack: boolean("show_usage_pack").notNull().default(false),
  memberInvitationAllowed: boolean("member_invitation_allowed")
    .notNull()
    .default(false),
  autoRechargeAllowed: boolean("auto_recharge_allowed")
    .notNull()
    .default(false),
  supportByok: boolean("support_byok").notNull().default(false),
  restrictedBuiltInModels: boolean("restricted_built_in_models").notNull(),
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
  sourceMetadata: jsonb("source_metadata").notNull().default({}),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

interface LegacyPlanArgs {
  readonly orgId: string;
  readonly planKey: string;
  readonly source: string;
  readonly memberInviteUsagePackRequired: boolean;
}

export function legacyOrgPlanEntitlementValues(args: LegacyPlanArgs) {
  return {
    ...args,
    planRank: 1,
    status: "active",
    baseConcurrencyLimit: 1,
    canBuyConcurrency: true,
    canBuyCredits: true,
    showUsagePack: args.memberInviteUsagePackRequired,
    memberInvitationAllowed: ![
      "free",
      "limited-free-1",
      "pro-suspend",
    ].includes(args.planKey),
    autoRechargeAllowed: true,
    supportByok: true,
    restrictedBuiltInModels: false,
    videoGenerationAllowed: true,
    workflowWebhookTriggerAllowed: true,
    audioLifetimeLimit: null,
    audioDailyRateLimit: 1,
    audioDailyDurationSeconds: 1,
    stripeSubscriptionId: null,
    stripePriceId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAt: null,
    expiresAt: null,
    sourceMetadata: {},
    updatedAt: new Date("2026-09-08T00:00:00.000Z"),
  };
}

export function upsertLegacyOrgPlanEntitlement(
  db: NodePgDatabase,
  args: LegacyPlanArgs,
) {
  const values = legacyOrgPlanEntitlementValues(args);
  return db
    .insert(legacyOrgPlanEntitlements)
    .values(values)
    .onConflictDoUpdate({
      target: legacyOrgPlanEntitlements.orgId,
      set: {
        planKey: values.planKey,
        planRank: values.planRank,
        source: values.source,
        status: values.status,
        baseConcurrencyLimit: values.baseConcurrencyLimit,
        canBuyConcurrency: values.canBuyConcurrency,
        canBuyCredits: values.canBuyCredits,
        memberInviteUsagePackRequired: values.memberInviteUsagePackRequired,
        showUsagePack: values.showUsagePack,
        memberInvitationAllowed: values.memberInvitationAllowed,
        autoRechargeAllowed: values.autoRechargeAllowed,
        supportByok: values.supportByok,
        restrictedBuiltInModels: values.restrictedBuiltInModels,
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
        updatedAt: values.updatedAt,
      },
    });
}
