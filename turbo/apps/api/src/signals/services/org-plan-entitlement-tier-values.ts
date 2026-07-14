import type { OrgTier } from "@vm0/api-contracts/contracts/orgs";

interface OrgTierLimits {
  readonly planRank: number;
  readonly baseConcurrencyLimit: number;
  readonly canBuyConcurrency: boolean;
  readonly autoRechargeAllowed: boolean;
  readonly supportByok: boolean;
  readonly restrictedVm0Models: boolean;
  readonly videoGenerationAllowed: boolean;
  readonly workflowWebhookTriggerAllowed: boolean;
  readonly audioLifetimeLimit: number | null;
  readonly audioDailyRateLimit: number;
  readonly audioDailyDurationSeconds: number;
}

/**
 * Tier values captured into org_plan_entitlements during billing writes.
 */
export const ORG_PLAN_ENTITLEMENT_TIER_VALUES: Readonly<
  Record<OrgTier, OrgTierLimits>
> = {
  free: {
    planRank: 0,
    baseConcurrencyLimit: 1,
    canBuyConcurrency: false,
    autoRechargeAllowed: false,
    supportByok: true,
    restrictedVm0Models: false,
    videoGenerationAllowed: true,
    workflowWebhookTriggerAllowed: false,
    audioLifetimeLimit: 10,
    audioDailyRateLimit: 10,
    audioDailyDurationSeconds: 10 * 60,
  },
  "limited-free-1": {
    planRank: 0,
    baseConcurrencyLimit: 1,
    canBuyConcurrency: false,
    autoRechargeAllowed: false,
    supportByok: false,
    restrictedVm0Models: true,
    videoGenerationAllowed: false,
    workflowWebhookTriggerAllowed: false,
    audioLifetimeLimit: 10,
    audioDailyRateLimit: 10,
    audioDailyDurationSeconds: 10 * 60,
  },
  "pro-suspend": {
    planRank: 0,
    baseConcurrencyLimit: 0,
    canBuyConcurrency: false,
    autoRechargeAllowed: false,
    supportByok: false,
    restrictedVm0Models: true,
    videoGenerationAllowed: false,
    workflowWebhookTriggerAllowed: false,
    audioLifetimeLimit: 0,
    audioDailyRateLimit: 0,
    audioDailyDurationSeconds: 0,
  },
  pro: {
    planRank: 1,
    baseConcurrencyLimit: 2,
    canBuyConcurrency: false,
    autoRechargeAllowed: true,
    supportByok: true,
    restrictedVm0Models: false,
    videoGenerationAllowed: true,
    workflowWebhookTriggerAllowed: false,
    audioLifetimeLimit: null,
    audioDailyRateLimit: 300,
    audioDailyDurationSeconds: 200 * 60,
  },
  team: {
    planRank: 2,
    baseConcurrencyLimit: 10,
    canBuyConcurrency: true,
    autoRechargeAllowed: true,
    supportByok: true,
    restrictedVm0Models: false,
    videoGenerationAllowed: true,
    workflowWebhookTriggerAllowed: true,
    audioLifetimeLimit: null,
    audioDailyRateLimit: 500,
    audioDailyDurationSeconds: 500 * 60,
  },
  custom: {
    planRank: 3,
    baseConcurrencyLimit: 10,
    canBuyConcurrency: true,
    autoRechargeAllowed: true,
    supportByok: true,
    restrictedVm0Models: false,
    videoGenerationAllowed: true,
    workflowWebhookTriggerAllowed: true,
    audioLifetimeLimit: null,
    audioDailyRateLimit: 500,
    audioDailyDurationSeconds: 500 * 60,
  },
};
