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
  return paidOnboardingUrl ? [getAppUrl(), paidOnboardingUrl] : [getAppUrl()];
}
