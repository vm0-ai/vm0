import { env } from "../../env";

export function getAppUrl(): string {
  return env().NEXT_PUBLIC_APP_URL;
}

// Origins Clerk is allowed to redirect back to after sign-in/sign-up. Always
// includes the app; optionally includes the paid-onboarding origin (so.vm0.ai)
// when configured per environment, so a paid onboarding flow hosted on a
// sibling *.vm0.ai subdomain can run auth on www and return to itself.
export function getAllowedRedirectOrigins(): string[] {
  const appUrl = getAppUrl();
  const paidOnboardingUrl = env().NEXT_PUBLIC_PAID_ONBOARDING_URL;
  const origins = paidOnboardingUrl ? [appUrl, paidOnboardingUrl] : [appUrl];

  // Any vm6.ai app/web preview is staging-only. Allow the whole *.vm6.ai
  // family so paid onboarding previews can run auth on the paired web preview
  // or staging-www and still return to themselves.
  if (
    origins.some((origin) => {
      return isVm6Origin(origin);
    })
  ) {
    origins.push("https://*.vm6.ai");
  }

  return origins;
}

function isVm6Origin(origin: string): boolean {
  try {
    return new URL(origin).hostname.endsWith(".vm6.ai");
  } catch {
    return false;
  }
}
