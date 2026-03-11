import { useCCState, useCommand } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
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
import {
  zeroActiveId$,
  setZeroActiveId$,
} from "../../signals/zero-page/zero-nav.ts";
import { updateSearchParams$ } from "../../signals/route.ts";
import {
  zeroSessionList$,
  zeroSessionListLoading$,
  zeroSessionListError$,
  zeroCurrentSessionId$,
  fetchZeroSessionList$,
  switchZeroSession$,
  startNewZeroSession$,
  sendZeroChatMessage$,
  sendZeroIntroMessage$,
} from "../../signals/zero-page/zero-chat.ts";

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

function useSkeletonVisibility(isLoggedIn: boolean, dataReady: boolean) {
  return isLoggedIn && !dataReady;
}

/**
 * Manages session lifecycle: fetches session list when onboarding completes,
 * and auto-sends an introductory message for new users.
 */
function useSessionLifecycle(
  isLoggedIn: boolean,
  onboardingReady: boolean,
  needsOnboarding: boolean,
) {
  const recentSessions = useGet(zeroSessionList$);
  const recentSessionsLoading = useGet(zeroSessionListLoading$);
  const recentSessionsError = useGet(zeroSessionListError$);
  const fetchSessionList = useSet(fetchZeroSessionList$);
  const sendIntro = useSet(sendZeroIntroMessage$);

  // "init" → "onboarding" → "ready" lifecycle
  const lifecycleRef$ = useCCState<"init" | "onboarding" | "ready">("init");
  const lifecycle = useGet(lifecycleRef$);
  const setLifecycle = useSet(lifecycleRef$);

  if (isLoggedIn && onboardingReady) {
    if (needsOnboarding && lifecycle === "init") {
      queueMicrotask(() => setLifecycle("onboarding"));
    } else if (!needsOnboarding && lifecycle !== "ready") {
      const wasOnboarding = lifecycle === "onboarding";
      queueMicrotask(() => {
        setLifecycle("ready");
        detach(fetchSessionList(), Reason.DomCallback);
        if (wasOnboarding) {
          detach(
            sendIntro("Who are you and what can you do?"),
            Reason.DomCallback,
          );
        }
      });
    }
  }

  return { recentSessions, recentSessionsLoading, recentSessionsError };
}

export function ZeroAppShell() {
  const userLoadable = useLoadable(user$);
  const isLoggedIn =
    userLoadable.state === "hasData" && userLoadable.data !== undefined;
  // useLastLoadable keeps the previous value during re-fetches (e.g. Clerk
  // session touch), preventing the onboarding dialog from unmounting.
  const onboardingLoadable = useLastLoadable(zeroNeedsOnboarding$);
  const onboardingReady = onboardingLoadable.state === "hasData";
  const needsOnboarding =
    onboardingLoadable.state === "hasData" && onboardingLoadable.data === true;
  const showOnboarding = isLoggedIn && onboardingReady && needsOnboarding;
  const agentDisplayNameLoadable = useLastLoadable(agentDisplayName$);
  const agentNameReady = agentDisplayNameLoadable.state === "hasData";
  const agentDisplayName = agentNameReady
    ? agentDisplayNameLoadable.data
    : "Zero";
  const activeId = useGet(zeroActiveId$);
  const setActiveId = useSet(setZeroActiveId$);
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

  const inSession$ = useCCState(false);
  const inSession = useGet(inSession$);
  const currentSessionId = useGet(zeroCurrentSessionId$);
  const switchSession = useSet(switchZeroSession$);
  const startNewSession = useSet(startNewZeroSession$);
  const sendMessage = useSet(sendZeroChatMessage$);

  const { recentSessions, recentSessionsLoading, recentSessionsError } =
    useSessionLifecycle(isLoggedIn, onboardingReady, needsOnboarding);

  const handleRecentSelect$ = useCommand(({ set }, sessionId: string) => {
    set(setZeroActiveId$, "chat");
    set(inSession$, true);
    detach(switchSession(sessionId), Reason.DomCallback);
  });
  const handleRecentSelect = useSet(handleRecentSelect$);

  const handleNewChat$ = useCommand(({ set }) => {
    set(setZeroActiveId$, "chat");
    set(inSession$, true);
    startNewSession();
  });
  const handleNewChat = useSet(handleNewChat$);

  const handleSendFromDemo$ = useCommand(({ set }, message: string) => {
    set(inSession$, true);
    startNewSession();
    detach(sendMessage(message), Reason.DomCallback);
  });
  const handleSendFromDemo = useSet(handleSendFromDemo$);

  const handleBackFromSession$ = useCommand(({ set }) => {
    set(inSession$, false);
  });
  const handleBackFromSession = useSet(handleBackFromSession$);

  const handleNavSelect$ = useCommand(({ set }, id: ZeroNavId) => {
    set(setZeroActiveId$, id);
    set(inSession$, false);
    set(showAboutPage$, false);
  });
  const handleNavSelect = useSet(handleNavSelect$);

  const handleAccountAction$ = useCommand(
    ({ set }, action: ZeroAccountAction) => {
      if (action === "signout" || action === "manage") {
        return;
      }
      set(setZeroActiveId$, "account");
      set(accountSubId$, action as ZeroAccountSubId);
    },
  );
  const handleAccountAction = useSet(handleAccountAction$);

  const updateSearchParams = useSet(updateSearchParams$);
  const resetDefaultAgent = useSet(resetDefaultAgent$);

  const dataReady = isLoggedIn && onboardingReady && agentNameReady;
  const showSkeleton = useSkeletonVisibility(isLoggedIn, dataReady);

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
        selectedRecentId={
          activeId === "chat" && inSession ? currentSessionId : null
        }
        onAccountAction={handleAccountAction}
        recentSessions={recentSessions}
        recentSessionsLoading={recentSessionsLoading}
        recentSessionsError={recentSessionsError}
        onNewChat={handleNewChat}
        onResetAgent={() => detach(resetDefaultAgent(), Reason.DomCallback)}
      />
      <div className="flex flex-1 flex-col min-w-0 zero-workspace-bg">
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
            inSession={inSession}
            onSendMessage={handleSendFromDemo}
            onNavigateToActivity={() => setActiveId("activity")}
            onNavigateToSchedule={() => setActiveId("schedule")}
            onNavigateToJob={() => setActiveId("job")}
            onNavigateToChat={() => setActiveId("chat")}
            onNavigateToMeet={(section) => {
              setActiveId("meet");
              if (section) {
                const next = new URLSearchParams();
                next.set("section", section);
                updateSearchParams(next);
              }
            }}
            onBackFromSession={handleBackFromSession}
            zeroAvatarSrc={zeroAvatarSrc}
            onAvatarClick={cycleAvatar}
          />
        )}
      </div>
    </div>
  );
}
