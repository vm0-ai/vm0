import {
  bigint,
  boolean,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { agents } from "./agent";

/**
 * org_metadata — stores per-org data that is owned by the platform (not Clerk).
 * Holds credit balance, tier, default agent configuration, and Stripe billing fields.
 * Clerk remains source of truth for slug and membership only.
 */
export const orgMetadata = pgTable(
  "org_metadata",
  {
    orgId: text("org_id").primaryKey(),
    // Credits are granted explicitly through Stripe invoices, one-time purchases,
    // or legacy/manual grants. The column DEFAULT is 0 — never rely on the
    // default to materialise a grant.
    credits: bigint("credits", { mode: "number" }).notNull().default(0),
    tier: text("tier").notNull().default("limited-free-1"),
    defaultAgentId: uuid("default_agent_id"),
    onboardingPaymentPending: boolean("onboarding_payment_pending")
      .notNull()
      .default(false),
    onboardingComplete: boolean("onboarding_complete").notNull().default(false),
    // Stripe billing fields
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    subscriptionStatus: varchar("subscription_status", { length: 20 }),
    currentPeriodEnd: timestamp("current_period_end"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    pendingSubscriptionScheduleId: text("pending_subscription_schedule_id"),
    pendingSubscriptionTargetTier: text("pending_subscription_target_tier"),
    pendingSubscriptionChangeAt: timestamp("pending_subscription_change_at"),
    lastProcessedInvoiceId: text("last_processed_invoice_id"),
    // First-touch acquisition attribution. These fields are immutable after
    // capture and give billing/reporting a durable join to Google Ads IDs.
    acquisitionSourceType: text("acquisition_source_type"),
    acquisitionVm0Source: text("acquisition_vm0_source"),
    acquisitionCampaignId: text("acquisition_campaign_id"),
    acquisitionAdGroupId: text("acquisition_ad_group_id"),
    acquisitionCampaign: text("acquisition_campaign"),
    acquisitionUtmSource: text("acquisition_utm_source"),
    acquisitionUtmMedium: text("acquisition_utm_medium"),
    acquisitionUtmContent: text("acquisition_utm_content"),
    acquisitionUtmTerm: text("acquisition_utm_term"),
    acquisitionGclid: text("acquisition_gclid"),
    acquisitionGbraid: text("acquisition_gbraid"),
    acquisitionWbraid: text("acquisition_wbraid"),
    acquisitionGaClientId: text("acquisition_ga_client_id"),
    acquisitionLandingHost: text("acquisition_landing_host"),
    acquisitionLandingPath: text("acquisition_landing_path"),
    acquisitionReferrerDomain: text("acquisition_referrer_domain"),
    acquisitionRecordedAt: timestamp("acquisition_recorded_at"),
    // Auto-recharge configuration
    autoRechargeEnabled: boolean("auto_recharge_enabled")
      .notNull()
      .default(false),
    autoRechargeThreshold: bigint("auto_recharge_threshold", {
      mode: "number",
    }),
    autoRechargeAmount: bigint("auto_recharge_amount", { mode: "number" }),
    autoRechargePendingAt: timestamp("auto_recharge_pending_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "org_metadata_default_agent_id_agents_id_fk",
        columns: [table.defaultAgentId],
        foreignColumns: [agents.id],
      }).onDelete("set null"),
      uniqueIndex("uq_org_stripe_customer").on(table.stripeCustomerId),
      index("idx_org_metadata_acquisition_campaign_id").on(
        table.acquisitionCampaignId,
      ),
      index("idx_org_metadata_acquisition_ad_group_id").on(
        table.acquisitionAdGroupId,
      ),
    ];
  },
);
