import { useCCState, useCommand } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  ZeroSidebar,
  type ZeroNavId,
  type ZeroAccountAction,
  type ZeroAccountSubId,
} from "./zero-sidebar.tsx";
import { Button } from "@vm0/ui";
import { ZeroAboutPage } from "./zero-about-page.tsx";
import { ZeroContent } from "./zero-content.tsx";
import { ZeroOnboarding } from "./zero-onboarding.tsx";
import { user$ } from "../../signals/auth.ts";
import { zeroNeedsOnboarding$ } from "../../signals/zero-page/zero-onboarding.ts";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import { resetDefaultAgent$ } from "../../signals/zero-page/zero-dev-tools.ts";
import { detach, Reason } from "../../signals/utils.ts";

const ZERO_AVATARS = [
  "/zero-avatar.png",
  "/avatars/avatar-1.png",
  "/avatars/avatar-2.png",
  "/avatars/avatar-3.png",
  "/avatars/avatar-4.png",
] as const;

function ZeroAppSkeleton({ visible }: { visible: boolean }) {
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
        {/* Org switcher */}
        <div className="shrink-0 p-2 pb-1">
          <div className="rounded-lg p-2">
            <div className="h-8 w-full rounded-lg bg-muted/50 animate-pulse" />
          </div>
        </div>
        {/* Nav + Recent */}
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
          {/* Recent section */}
          <div className="mt-4">
            <div className="h-8 flex items-center px-2">
              <div className="h-3 w-20 rounded bg-muted/30 animate-pulse" />
            </div>
            <div className="flex flex-col gap-1">
              {["recent-1", "recent-2", "recent-3"].map((id, i) => (
                <div key={id} className="flex h-8 items-center rounded-lg p-2">
                  <div
                    className="h-3.5 rounded bg-muted/40 animate-pulse"
                    style={{ width: `${100 + ((i * 43) % 80)}px` }}
                  />
                </div>
              ))}
            </div>
          </div>
        </nav>
        {/* Footer */}
        <div className="p-2">
          <div className="flex flex-col gap-1">
            <div className="flex h-8 items-center gap-2 rounded-lg p-2">
              <div className="h-4 w-4 rounded bg-muted/50 animate-pulse shrink-0" />
              <div className="h-3.5 w-28 rounded bg-muted/50 animate-pulse" />
            </div>
            {/* Account */}
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

function getRecentLabels(agentName: string): Readonly<Record<string, string>> {
  return {
    hello: `Hello from ${agentName}`,
    "1": "Daily digest workflow",
    "2": "Set up Slack integration",
    "3": "Weekly report automation",
    "4": "Code review reminders",
  };
}

export function ZeroAppShell() {
  const userLoadable = useLoadable(user$);
  const isLoggedIn =
    userLoadable.state === "hasData" && userLoadable.data !== undefined;
  const onboardingLoadable = useLoadable(zeroNeedsOnboarding$);
  const showOnboarding =
    isLoggedIn &&
    onboardingLoadable.state === "hasData" &&
    onboardingLoadable.data === true;
  const agentDisplayNameLoadable = useLoadable(agentDisplayName$);
  const agentDisplayName =
    agentDisplayNameLoadable.state === "hasData"
      ? agentDisplayNameLoadable.data
      : "Zero";
  const activeId$ = useCCState<ZeroNavId>("chat");
  const activeId = useGet(activeId$);
  const setActiveId = useSet(activeId$);
  const recentId$ = useCCState<string | null>(null);
  const recentId = useGet(recentId$);
  const accountSubId$ = useCCState<ZeroAccountSubId>(null);
  const accountSubId = useGet(accountSubId$);
  const avatarIndex$ = useCCState(0);
  const avatarIndex = useGet(avatarIndex$);
  const showAboutPage$ = useCCState(false);
  const showAboutPage = useGet(showAboutPage$);
  const setShowAboutPage = useSet(showAboutPage$);
  const zeroAvatarSrc = ZERO_AVATARS[avatarIndex] ?? ZERO_AVATARS[0];
  const cycleAvatar$ = useCommand(({ set }) => {
    set(avatarIndex$, (i: number) => (i + 1) % ZERO_AVATARS.length);
  });
  const cycleAvatar = useSet(cycleAvatar$);

  const handleRecentSelect$ = useCommand(({ set }, id: string) => {
    set(recentId$, id);
    set(activeId$, "chat" as ZeroNavId);
  });
  const handleRecentSelect = useSet(handleRecentSelect$);

  const handleNavSelect$ = useCommand(({ set }, id: ZeroNavId) => {
    set(activeId$, id);
    set(recentId$, null);
    set(showAboutPage$, false);
  });
  const handleNavSelect = useSet(handleNavSelect$);

  const handleAccountAction$ = useCommand(
    ({ set }, action: ZeroAccountAction) => {
      if (action === "signout" || action === "manage") {
        return;
      }
      set(activeId$, "account" as ZeroNavId);
      set(accountSubId$, action as ZeroAccountSubId);
    },
  );
  const handleAccountAction = useSet(handleAccountAction$);

  const handleClearRecent$ = useCommand(({ set }) => {
    set(recentId$, null);
  });
  const handleClearRecent = useSet(handleClearRecent$);

  const resetDefaultAgent = useSet(resetDefaultAgent$);

  const recentLabel = recentId
    ? (getRecentLabels(agentDisplayName)[recentId] ?? null)
    : null;

  const dataReady =
    isLoggedIn &&
    onboardingLoadable.state === "hasData" &&
    agentDisplayNameLoadable.state === "hasData";

  // Track: once data has been ready, never show skeleton again
  const everReady$ = useCCState(false);
  const everReady = useGet(everReady$);
  const setEverReady = useSet(everReady$);
  if (dataReady && !everReady) {
    setEverReady(true);
  }

  // Show skeleton only for logged-in users whose data hasn't arrived yet
  const showSkeleton = isLoggedIn && !dataReady && !everReady;

  return (
    <div className="zero-app flex h-dvh w-full bg-background">
      <ZeroAppSkeleton visible={showSkeleton} />
      {showOnboarding && (
        <ZeroOnboarding
          zeroAvatarSrc={zeroAvatarSrc}
          onAvatarClick={cycleAvatar}
        />
      )}
      <ZeroSidebar
        activeId={activeId}
        agentName={agentDisplayName}
        onSelect={handleNavSelect}
        onRecentSelect={handleRecentSelect}
        selectedRecentId={activeId === "chat" ? recentId : null}
        onAccountAction={handleAccountAction}
      />
      <div className="flex flex-1 flex-col min-w-0 zero-workspace-bg">
        {import.meta.env.DEV && isLoggedIn && (
          <div className="absolute right-6 top-6 z-10">
            <button
              type="button"
              onClick={() => detach(resetDefaultAgent(), Reason.DomCallback)}
              className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-500/20"
            >
              Reset Default Agent
            </button>
          </div>
        )}
        {!isLoggedIn && (
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
                <Button
                  size="sm"
                  className="h-9 rounded-lg px-4 text-sm font-medium"
                >
                  Sign in
                </Button>
              </a>
            </div>
          </nav>
        )}
        {showAboutPage ? (
          <ZeroAboutPage onBack={() => setShowAboutPage(false)} />
        ) : (
          <ZeroContent
            sectionId={activeId}
            accountSubId={accountSubId}
            recentLabel={recentLabel}
            recentId={recentId}
            onClearRecent={handleClearRecent}
            onNavigateToActivity={() => setActiveId("activity")}
            onNavigateToSchedule={() => setActiveId("schedule")}
            onNavigateToJob={() => setActiveId("job")}
            onNavigateToChat={() => setActiveId("chat")}
            zeroAvatarSrc={zeroAvatarSrc}
            onAvatarClick={cycleAvatar}
          />
        )}
      </div>
    </div>
  );
}
