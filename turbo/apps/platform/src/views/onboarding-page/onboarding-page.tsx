import { useLastResolved } from "ccstate-react";
import { ZeroOnboarding } from "../zero-page/zero-onboarding.tsx";
import { onboardingShowDialog$ } from "../../signals/zero-page/zero-onboarding-actions.ts";

export function OnboardingPage() {
  const showOnboarding = useLastResolved(onboardingShowDialog$) ?? false;

  return (
    <div className="h-dvh w-full">{showOnboarding && <ZeroOnboarding />}</div>
  );
}
