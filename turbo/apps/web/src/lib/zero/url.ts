import { env } from "../../env";

export function getAppUrl(): string {
  return env().NEXT_PUBLIC_APP_URL;
}

// Origins Clerk is allowed to redirect back to after sign-in/sign-up. Always
// includes the app; optionally includes the paid-onboarding origin (so.vm0.ai)
// when configured per environment, so a paid onboarding flow hosted on a
// sibling *.vm0.ai subdomain can run auth on www and return to itself.
export function getAllowedRedirectOrigins(): string[] {
  const paidOnboardingUrl = env().NEXT_PUBLIC_PAID_ONBOARDING_URL;
  if (!paidOnboardingUrl) {
    return [getAppUrl()];
  }
  const origins = [getAppUrl(), paidOnboardingUrl];
  // On the staging preview domain the paid LP/onboarding surface is deployed
  // per preview (pr-N-so.vm6.ai, or the raw <hash>.vm6.ai). Allow the whole
  // *.vm6.ai family so each preview can run auth on staging-www and return to
  // itself. Production keeps the exact origin (so.vm0.ai), never a wildcard.
  try {
    if (new URL(paidOnboardingUrl).hostname.endsWith(".vm6.ai")) {
      origins.push("https://*.vm6.ai");
    }
  } catch {
    // Ignore a malformed paid-onboarding URL; the exact origin above still applies.
  }
  return origins;
}
