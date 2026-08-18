import type {
  StripeClient,
  StripeSubscription,
} from "../external/stripe-client";
import { stripePreviewMetadata } from "./stripe-preview-metadata.service";

export const USAGE_PACK_SUBSCRIPTION_PURPOSE = "usage_pack_subscription";
export const USAGE_PACK_SUBSCRIPTION_ID_METADATA_KEY =
  "usagePackSubscriptionId";

type UsagePackTier = "pro" | "team";

interface UsagePackSubscriptionMetadataArgs {
  readonly orgId: string;
  readonly tier: UsagePackTier;
  readonly planPriceId: string;
  readonly usagePackSubscriptionId: string;
}

export function usagePackSubscriptionMetadata(
  args: UsagePackSubscriptionMetadataArgs,
): Record<string, string> {
  return {
    orgId: args.orgId,
    tier: args.tier,
    priceId: args.planPriceId,
    purpose: USAGE_PACK_SUBSCRIPTION_PURPOSE,
    [USAGE_PACK_SUBSCRIPTION_ID_METADATA_KEY]: args.usagePackSubscriptionId,
    ...stripePreviewMetadata(),
  };
}

export async function updateUsagePackSubscriptionMetadata(
  stripe: StripeClient,
  args: UsagePackSubscriptionMetadataArgs & {
    readonly subscription: StripeSubscription;
    readonly idempotencyKey: string;
  },
): Promise<StripeSubscription> {
  const metadata = {
    ...args.subscription.metadata,
    ...usagePackSubscriptionMetadata(args),
  };
  await stripe.subscriptions.update(
    args.subscription.id,
    { metadata },
    { idempotencyKey: args.idempotencyKey },
  );
  return { ...args.subscription, metadata };
}
