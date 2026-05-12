import { useEffect } from "react";
import { useLastResolved } from "ccstate-react";
import { ZeroOnboarding } from "../zero-page/zero-onboarding.tsx";
import { onboardingShowDialog$ } from "../../signals/zero-page/zero-onboarding-actions.ts";

export function OnboardingPage() {
  const showOnboarding = useLastResolved(onboardingShowDialog$) ?? false;

  useEffect(() => {
    // Fire Google Ads conversion event when user reaches onboarding after signup
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).gtag?.("event", "conversion", {
      send_to: "AW-18144854014/OlLBCNXGgqwcEP7_kcxD",
    });
  }, []);

  return (
    <div className="h-dvh w-full">{showOnboarding && <ZeroOnboarding />}</div>
  );
}
