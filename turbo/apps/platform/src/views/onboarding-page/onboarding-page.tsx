import { useLoadable, useLastLoadable } from "ccstate-react";
import { ZeroOnboarding } from "../zero-page/zero-onboarding.tsx";
import { user$ } from "../../signals/auth.ts";
import {
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
} from "../../signals/zero-page/zero-onboarding.ts";

export function OnboardingPage() {
  const userLoadable = useLoadable(user$);
  const isLoggedIn =
    userLoadable.state === "hasData" && userLoadable.data !== undefined;

  const onboardingLoadable = useLastLoadable(zeroNeedsOnboarding$);
  const isAdmin =
    onboardingLoadable.state === "hasData" && onboardingLoadable.data === true;

  const memberOnboarding = useLastLoadable(zeroNeedsMemberOnboarding$);
  const isMember =
    memberOnboarding.state === "hasData" && memberOnboarding.data === true;

  const showOnboarding = isLoggedIn && (isAdmin || isMember);

  return (
    <div className="h-dvh w-full">
      {showOnboarding && <ZeroOnboarding isAdmin={isAdmin} />}
    </div>
  );
}
