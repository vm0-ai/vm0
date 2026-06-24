import { env } from "../../env";

const VM0_ONBOARDING_PATH = "/onboarding/2afcf6";
const DEFAULT_PAID_ONBOARDING_URL = "https://so.vm0.ai";

function paidOnboardingBaseUrl(): string {
  return (
    env().NEXT_PUBLIC_PAID_ONBOARDING_URL || DEFAULT_PAID_ONBOARDING_URL
  ).replace(/\/+$/u, "");
}

export function buildVm0OnboardingEntryUrl(
  paramsInit?: URLSearchParams | string,
): string {
  const params =
    paramsInit instanceof URLSearchParams
      ? new URLSearchParams(paramsInit)
      : new URLSearchParams(paramsInit ?? "");
  const query = params.toString();

  return `${paidOnboardingBaseUrl()}${VM0_ONBOARDING_PATH}${query ? `?${query}` : ""}`;
}
