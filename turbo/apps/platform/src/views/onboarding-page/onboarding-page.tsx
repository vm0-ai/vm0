import { useGet, useLoadable, useLastLoadable } from "ccstate-react";
import { ZeroOnboarding } from "../zero-page/zero-onboarding.tsx";
import { user$ } from "../../signals/auth.ts";
import {
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
} from "../../signals/zero-page/zero-onboarding.ts";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import { zeroAvatarIndex$ } from "../../signals/zero-page/zero-nav.ts";
import { ZERO_AVATARS } from "../zero-page/zero-avatars.ts";

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

  const agentDisplayNameLoadable = useLastLoadable(agentDisplayName$);
  const agentDisplayName =
    agentDisplayNameLoadable.state === "hasData"
      ? agentDisplayNameLoadable.data
      : "Zero";

  const avatarIndex = useGet(zeroAvatarIndex$);
  const zeroAvatarSrc = ZERO_AVATARS[avatarIndex] ?? ZERO_AVATARS[0];

  const showOnboarding = isLoggedIn && (isAdmin || isMember);

  return (
    <div className="h-dvh w-full">
      {showOnboarding && (
        <ZeroOnboarding
          zeroAvatarSrc={zeroAvatarSrc}
          isAdmin={isAdmin}
          displayName={agentDisplayName}
        />
      )}
    </div>
  );
}
