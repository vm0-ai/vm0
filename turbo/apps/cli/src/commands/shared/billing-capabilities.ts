import type { BillingStatusResponse } from "@okouai/api-contracts/contracts/zero-billing";
import { decodeSandboxTokenPayload } from "../../lib/api/sandbox-token";

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
  const payload = decodeSandboxTokenPayload();
  return payload === undefined || payload.capabilities.includes("billing:read");
}
