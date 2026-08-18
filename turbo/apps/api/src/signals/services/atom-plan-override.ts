const ATOM_PLAN_OVERRIDE_MODE_METADATA_KEY = "planOverrideMode";
const PRESERVE_PURCHASED_PRO_OVERRIDE_MODE = "preserve_purchased_pro_v1";
const PRESERVED_PURCHASED_PRO_SUBSCRIPTION_ID_METADATA_KEY =
  "preservedPurchasedProSubscriptionId";

export function requestsPurchasedProPreservation(
  metadata: Readonly<Record<string, string>> | null | undefined,
): boolean {
  return (
    metadata?.[ATOM_PLAN_OVERRIDE_MODE_METADATA_KEY] ===
    PRESERVE_PURCHASED_PRO_OVERRIDE_MODE
  );
}

export function preservedPurchasedProSubscriptionId(
  metadata: Readonly<Record<string, string>> | null | undefined,
): string | null {
  return (
    metadata?.[PRESERVED_PURCHASED_PRO_SUBSCRIPTION_ID_METADATA_KEY] ?? null
  );
}

export function withPreservedPurchasedProSubscription(
  metadata: Readonly<Record<string, string>>,
  subscriptionId: string | null,
): Record<string, string> {
  return subscriptionId
    ? {
        ...metadata,
        [PRESERVED_PURCHASED_PRO_SUBSCRIPTION_ID_METADATA_KEY]: subscriptionId,
      }
    : { ...metadata };
}
