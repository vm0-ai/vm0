import type { BillingStatusResponse } from "@vm0/api-contracts/contracts/zero-billing";
import { decodeZeroTokenPayload } from "../../../lib/api/zero-token";

function legacyPaidCapability(tier: string): boolean {
  return tier !== "limited-free-1" && tier !== "pro-suspend";
}

export function currentPlanCanBuyCredits(
  billing: BillingStatusResponse,
): boolean {
  return billing.canBuyCredits ?? legacyPaidCapability(billing.tier);
}

export function currentPlanAllowsVideo(
  billing: BillingStatusResponse,
): boolean {
  return billing.videoGenerationAllowed ?? legacyPaidCapability(billing.tier);
}

export function currentTokenCanReadBilling(): boolean {
  const payload = decodeZeroTokenPayload();
  return payload === undefined || payload.capabilities.includes("billing:read");
}
