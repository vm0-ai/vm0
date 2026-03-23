import type { ReactNode } from "react";
import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
import { Button } from "@vm0/ui";
import { ZeroSidebar } from "./zero-sidebar.tsx";
import { ZeroOnboarding, MemberWelcome } from "./zero-onboarding.tsx";
import { user$ } from "../../signals/auth.ts";
import {
  zeroNeedsOnboarding$,
  zeroNeedsMemberOnboarding$,
} from "../../signals/zero-page/zero-onboarding.ts";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import {
  zeroAvatarIndex$,
  zeroShowAboutPage$,
  setZeroShowAboutPage$,
  zeroSidebarCollapsed$,
  setZeroSidebarCollapsed$,
} from "../../signals/zero-page/zero-nav.ts";
import { ZeroAboutPage } from "./zero-about-page.tsx";

import zeroAvatarImg from "./assets/zero-avatar.webp";
import avatar1Img from "./assets/avatar-1.webp";
import avatar2Img from "./assets/avatar-2.webp";
import avatar3Img from "./assets/avatar-3.webp";
import avatar4Img from "./assets/avatar-4.webp";

const ZERO_AVATARS = [
  zeroAvatarImg,
  avatar1Img,
  avatar2Img,
  avatar3Img,
  avatar4Img,
] as const;

function SidebarLayoutSkeleton() {
  const userLoadable = useLoadable(user$);
  const isLoggedIn =
    userLoadable.state === "hasData" && userLoadable.data !== undefined;
  const onboardingLoadable = useLastLoadable(zeroNeedsOnboarding$);
  const onboardingReady = onboardingLoadable.state === "hasData";
  const agentNameLoadable = useLastLoadable(agentDisplayName$);
  const agentNameReady = agentNameLoadable.state === "hasData";
  const visible = isLoggedIn && !(onboardingReady && agentNameReady);

  return (
    <div
      className={`fixed inset-0 z-50 flex bg-background ${
        visible
          ? "opacity-100"
          : "opacity-0 pointer-events-none transition-opacity duration-300"
      }`}
    >
      {/* Sidebar skeleton */}
      <aside className="flex h-full w-[255px] shrink-0 flex-col border-r border-sidebar-border bg-sidebar overflow-hidden">
        <div className="shrink-0 p-2 pb-1">
          <div className="rounded-lg p-2">
            <div className="h-8 w-full rounded-lg bg-muted/50 animate-pulse" />
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
                  <div className="h-4 w-4 rounded bg-muted/50 animate-pulse shrink-0" />
                  <div
                    className="h-3.5 rounded bg-muted/50 animate-pulse"
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
              <div className="h-4 w-4 rounded bg-muted/50 animate-pulse shrink-0" />
              <div className="h-3.5 w-28 rounded bg-muted/50 animate-pulse" />
            </div>
            <div className="mt-2 pt-1">
              <div className="rounded-lg p-2">
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 shrink-0 rounded-xl bg-muted/50 animate-pulse" />
                  <div className="flex-1 min-w-0">
                    <div className="h-3.5 w-24 rounded bg-muted/50 animate-pulse" />
                    <div className="h-3 w-32 rounded bg-muted/30 animate-pulse mt-1" />
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
          <div className="h-6 w-40 rounded bg-muted/50 animate-pulse mb-2" />
          <div className="h-4 w-64 rounded bg-muted/30 animate-pulse" />
        </div>
        <div className="flex-1 px-6">
          <div className="mx-auto max-w-[900px]">
            <div className="h-48 rounded-xl bg-muted/20 animate-pulse" />
          </div>
        </div>
      </div>
    </div>
  );
}

function GuestNavBar() {
  const setShowAboutPage = useSet(setZeroShowAboutPage$);

  return (
    <nav
      className="pointer-events-none absolute right-6 top-6 z-10"
      aria-label="Site links"
    >
      <div className="zero-float-card pointer-events-auto flex items-center gap-4 rounded-xl border border-border bg-card/95 px-4 py-2.5 backdrop-blur-sm">
        <button
          type="button"
          onClick={() => setShowAboutPage(true)}
          className="text-sm tracking-wide text-foreground hover:text-primary transition-colors duration-200"
        >
          About VM0
        </button>
        <a
          href="https://vm0.ai/pricing"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm tracking-wide text-foreground hover:text-primary transition-colors duration-200"
        >
          Pricing
        </a>
        <a href="/sign-in">
          <Button size="sm" className="h-9 rounded-lg px-4 text-sm font-medium">
            Sign in
          </Button>
        </a>
      </div>
    </nav>
  );
}

export function SidebarLayout({ children }: { children: ReactNode }) {
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

  const showAboutPage = useGet(zeroShowAboutPage$);
  const setShowAboutPage = useSet(setZeroShowAboutPage$);

  const sidebarCollapsed = useGet(zeroSidebarCollapsed$);
  const setSidebarCollapsed = useSet(setZeroSidebarCollapsed$);

  return (
    <div className="zero-app flex h-dvh w-full bg-background">
      <SidebarLayoutSkeleton />
      {showOnboarding && <ZeroOnboarding zeroAvatarSrc={zeroAvatarSrc} />}
      {showMemberWelcome && (
        <MemberWelcome
          agentName={agentDisplayName}
          zeroAvatarSrc={zeroAvatarSrc}
        />
      )}
      <ZeroSidebar />
      {!sidebarCollapsed && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setSidebarCollapsed(true)}
        />
      )}
      <div className="flex flex-1 flex-col min-w-0 min-h-0 zero-workspace-bg">
        {!isLoggedIn && <GuestNavBar />}
        {showAboutPage ? (
          <ZeroAboutPage onBack={() => setShowAboutPage(false)} />
        ) : (
          children
        )}
      </div>
    </div>
  );
}
