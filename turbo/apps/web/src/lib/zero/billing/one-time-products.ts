import { env } from "../../../env";

/**
 * Server-side registry of one-time redemption campaigns.
 *
 * A campaign is the unit a user redeems via the platform `/redeem/:campaign`
 * page (which calls `POST /api/zero/billing/redeem/:campaign`). It bundles:
 *   - business policy (credits, expiry, source) — hardcoded here so ops can't
 *     inflate credits by flipping an env var;
 *   - Stripe identifiers (priceId, couponId) — sourced from env so test and
 *     live Stripe accounts can point at different prices/coupons without a
 *     code change.
 *
 * Both the redeem API route and the `checkout.session.completed` webhook read
 * through {@link getCampaign}; credit amounts never come from URL params or
 * Stripe metadata.
 */
interface CampaignPolicy {
  credits: number;
  expiresDays: number;
  source: string;
}

const CAMPAIGN_POLICY: Record<string, CampaignPolicy> = {
  ZERO100: {
    credits: 100_000,
    expiresDays: 30,
    source: "one_time_purchase",
  },
};

export function getCampaign(key: string) {
  const policy = CAMPAIGN_POLICY[key];
  const config = env().ZERO_ONE_TIME_CAMPAIGN?.[key];
  if (!policy || !config) return undefined;
  return { ...policy, ...config };
}
