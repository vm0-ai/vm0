import type { BillingStatusResponse } from "@vm0/api-contracts/contracts/zero-billing";
import { decodeZeroTokenPayload } from "../../../lib/api/zero-token";

export function currentPlanCanBuyCredits(
  billing: BillingStatusResponse,
): boolean {
  return billing.canBuyCredits === true;
}

export function currentPlanAllowsVideo(
  billing: BillingStatusResponse,
): boolean {
  return billing.videoGenerationAllowed === true;
}

export function currentTokenCanReadBilling(): boolean {
  const payload = decodeZeroTokenPayload();
  return payload === undefined || payload.capabilities.includes("billing:read");
}
