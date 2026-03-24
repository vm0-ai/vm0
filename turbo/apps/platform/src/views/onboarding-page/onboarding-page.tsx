import { useGet, useLoadable, useLastLoadable } from "ccstate-react";
import {
  ZeroOnboarding,
  MemberWelcome,
} from "../zero-page/zero-onboarding.tsx";
import { user$ } from "../../signals/auth.ts";
import {
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
} from "../../signals/zero-page/zero-onboarding.ts";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import { zeroAvatarIndex$ } from "../../signals/zero-page/zero-nav.ts";
import { ZERO_AVATARS } from "../zero-page/zero-avatars.ts";

function OnboardingStaticSkeleton() {
  return (
    <div className="flex h-full w-full bg-background">
      {/* Sidebar skeleton */}
      <aside className="flex h-full w-[300px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar overflow-hidden">
        <div className="shrink-0 p-2 pb-1">
          <div className="rounded-lg p-2">
            <div className="h-8 w-full rounded-lg bg-muted/50" />
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto overflow-x-hidden p-2">
          <div className="flex flex-col gap-1">
            {["nav-1", "nav-2", "nav-3", "nav-4", "nav-5", "nav-6"].map(
              (id, i) => (
                <div
                  key={id}
                  className="flex h-8 items-center gap-2 rounded-lg p-2"
                >
                  <div className="h-4 w-4 rounded bg-muted/50 shrink-0" />
                  <div
                    className="h-3.5 rounded bg-muted/50"
                    style={{ width: `${80 + ((i * 37) % 60)}px` }}
                  />
                </div>
              ),
            )}
          </div>
        </nav>
        <div className="p-2">
          <div className="flex flex-col gap-1">
            <div className="flex h-8 items-center gap-2 rounded-lg p-2">
              <div className="h-4 w-4 rounded bg-muted/50 shrink-0" />
              <div className="h-3.5 w-28 rounded bg-muted/50" />
            </div>
            <div className="mt-2 pt-1">
              <div className="rounded-lg p-2">
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 shrink-0 rounded-xl bg-muted/50" />
                  <div className="flex-1 min-w-0">
                    <div className="h-3.5 w-24 rounded bg-muted/50" />
                    <div className="h-3 w-32 rounded bg-muted/30 mt-1" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </aside>
      {/* Content skeleton */}
      <div className="flex flex-1 flex-col min-w-0 zero-workspace-bg">
        <div className="shrink-0 px-6 pt-6 pb-5">
          <div className="h-6 w-40 rounded bg-muted/50 mb-2" />
          <div className="h-4 w-64 rounded bg-muted/30" />
        </div>
        <div className="flex-1 px-6">
          <div className="mx-auto max-w-[900px]">
            <div className="h-48 rounded-xl bg-muted/20" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function OnboardingPage() {
  const userLoadable = useLoadable(user$);
  const isLoggedIn =
    userLoadable.state === "hasData" && userLoadable.data !== undefined;

  const onboardingLoadable = useLastLoadable(zeroNeedsOnboarding$);
  const needsOnboarding =
    onboardingLoadable.state === "hasData" && onboardingLoadable.data === true;
  const showOnboarding = isLoggedIn && needsOnboarding;

  const memberOnboarding = useLastLoadable(zeroNeedsMemberOnboarding$);
  const showMemberWelcome =
    isLoggedIn &&
    memberOnboarding.state === "hasData" &&
    memberOnboarding.data === true;

  const agentDisplayNameLoadable = useLastLoadable(agentDisplayName$);
  const agentDisplayName =
    agentDisplayNameLoadable.state === "hasData"
      ? agentDisplayNameLoadable.data
      : "Zero";

  const avatarIndex = useGet(zeroAvatarIndex$);
  const zeroAvatarSrc = ZERO_AVATARS[avatarIndex] ?? ZERO_AVATARS[0];

  return (
    <div className="relative h-dvh w-full bg-background">
      {/* Background: static skeleton */}
      <OnboardingStaticSkeleton />
      {/* Foreground: modal */}
      <div className="absolute inset-0 flex items-center justify-center">
        {showOnboarding && <ZeroOnboarding zeroAvatarSrc={zeroAvatarSrc} />}
        {showMemberWelcome && (
          <MemberWelcome
            agentName={agentDisplayName}
            zeroAvatarSrc={zeroAvatarSrc}
          />
        )}
      </div>
    </div>
  );
}
